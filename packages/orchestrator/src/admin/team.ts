/**
 * Admin panel → Businesses → Team. The operator gives someone (an accountant, an
 * auditor, a tester) access to a business's books, changes it, or takes it away —
 * with plain-language choices a non-technical operator can follow.
 *
 * Same team core as the owner's WhatsApp commands (identity/membership.ts), so the
 * rules are identical on both surfaces:
 *   - the person must reply JOIN from THEIR OWN WhatsApp (nobody is bound silently),
 *   - owner is never granted / changed / removed here,
 *   - plan seat + role limits apply (an explicit, audited "testing/support" override
 *     exists for the operator only),
 *   - every change is hash-chain audited on the business AND in admin_events,
 *   - the OWNER is told on WhatsApp whenever support changes their team.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import { minPlanFor, normalizePhone, planName, planSeats, type Role } from '@hisab/shared';
import { csrfField, esc, fmtDate, layout, pill, type Tone } from './html.js';
import {
  changeMember,
  INVITABLE_ROLES,
  INVITE_TTL_DAYS,
  inviteMember,
  listTeam,
  refreshInvite,
  removeMember,
  ROLE_ACCESS,
  seatsUsed,
  teamPlan,
  withArticle,
  type TeamStatus,
} from '../identity/membership.js';

type Form = Record<string, string | undefined>;
type Req = FastifyRequest;

export interface TeamRouteHelpers {
  db: Db;
  sendTemplate(to: string, template: string, params: string[]): Promise<string | void>;
  html(reply: FastifyReply, body: string, status?: number): FastifyReply;
  back(reply: FastifyReply, path: string, tone: Tone, text: string): FastifyReply;
  flashOf(req: FastifyRequest): { tone: Tone; text: string } | undefined;
  csrf(req: FastifyRequest): string;
  event(actor: string, action: string, detail: Record<string, unknown>, ip?: string): PromiseLike<unknown>;
  clientIp(req: FastifyRequest): string;
}

/** Access-length choices: label → days (null = until removed). ONE allowlist for form + parser. */
const ACCESS_CHOICES: readonly [string, string, number | null][] = [
  ['7', '7 days (quick test)', 7],
  ['30', '30 days', 30],
  ['90', '90 days (one quarter)', 90],
  ['365', '1 year', 365],
  ['none', 'Until I remove it', null],
];

const ROLE_TITLE: Record<Role, string> = {
  owner: 'Owner',
  accountant: 'Accountant',
  auditor: 'Auditor',
  staff: 'Staff',
  viewer: 'Viewer',
};

const STATUS_PILL: Record<TeamStatus, [string, Tone]> = {
  active: ['active', 'ok'],
  invited: ['waiting for JOIN', 'warn'],
  expired: ['access ended', 'muted'],
  invite_expired: ['invite expired', 'muted'],
  removed: ['removed', 'muted'],
};

/** Parse the access choice; undefined = invalid. 'keep' only where allowed. */
function parseAccess(value: string | undefined, allowKeep: boolean): number | null | 'keep' | undefined {
  if (allowKeep && value === 'keep') return 'keep';
  const hit = ACCESS_CHOICES.find(([v]) => v === value);
  return hit ? hit[2] : undefined;
}

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export function registerTeamRoutes(app: FastifyInstance, h: TeamRouteHelpers): void {
  const teamPath = (id: string) => `/admin/tenants/${id}/team`;

  const loadTenant = async (req: Req) => {
    const id = (req.params as { id: string }).id;
    if (!isUuid(id)) return null;
    const [t] = await h.db
      .select({ id: schema.tenants.id, name: schema.tenants.businessName, status: schema.tenants.status, owner: schema.tenants.whatsappE164 })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, id));
    return t ?? null;
  };

  /** Tell the owner on WhatsApp that support changed their team. Returns a flash suffix. */
  const notifyOwner = async (t: { id: string; name: string; owner: string | null }, change: string, req: Req) => {
    if (!t.owner) return ' The owner has no verified WhatsApp yet, so no notice was sent.';
    try {
      await h.sendTemplate(t.owner, 'team_access_update', [t.name, change]);
      return ' The owner was told on WhatsApp.';
    } catch (err) {
      await h.event('admin', 'team.owner_notice_failed', { tenant_id: t.id, error: String(err).slice(0, 200) }, h.clientIp(req));
      return ` The owner notice could not be sent (${String(err).slice(0, 120)}). Please tell the owner yourself.`;
    }
  };

  // ---- the page ----------------------------------------------------------------
  app.get('/admin/tenants/:id/team', async (req: Req, reply) => {
    const t = await loadTenant(req);
    if (!t) return h.back(reply, '/admin/tenants', 'bad', 'Business not found.');
    const [plan, used, rows] = await Promise.all([
      teamPlan(h.db, t.id),
      seatsUsed(h.db, t.id),
      listTeam(h.db, t.id, { history: true }),
    ]);
    const seats = planSeats(plan);
    const token = h.csrf(req);
    const free = Math.max(0, seats - used);

    const roleOptions = (selected: Role) =>
      INVITABLE_ROLES.map((r) => `<option value="${r}"${r === selected ? ' selected' : ''}>${ROLE_TITLE[r]}</option>`).join('');
    const accessOptions = (withKeep: boolean, selected: string) =>
      (withKeep ? `<option value="keep" selected>Keep current end date</option>` : '') +
      ACCESS_CHOICES.map(([v, label]) => `<option value="${v}"${!withKeep && v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

    const roleCards = INVITABLE_ROLES.map((r, i) => {
      const need = r === 'accountant' ? minPlanFor('accountant_seat') : null;
      const note = need ? ` <small>(${esc(planName(need))} plan or above)</small>` : '';
      return `<label class="opt"><input type="radio" name="role" value="${r}"${i === 1 ? ' checked' : ''} required>
        <span><b>${ROLE_TITLE[r]}</b>${note}<br><small>Can ${esc(ROLE_ACCESS[r])}.</small></span></label>`;
    }).join('');

    const tableRows = rows
      .map((m) => {
        const [label, tone] = m.role === 'owner' ? (['owner', 'ok'] as [string, Tone]) : STATUS_PILL[m.status];
        const current = m.status === 'active' || m.status === 'invited';
        const actions: string[] = [];
        const post = (action: string, inner: string) =>
          `<form method="post" action="${teamPath(t.id)}/${action}" class="row">${csrfField(token)}<input type="hidden" name="phone" value="${esc(m.e164)}">${inner}</form>`;
        if (m.role !== 'owner' && current) {
          actions.push(
            post(
              'update',
              `<select name="role" style="width:auto" aria-label="Role">${roleOptions(m.role)}</select>
               <select name="access" style="width:auto" aria-label="Access length">${accessOptions(true, '')}</select>
               <button class="ghost">Save</button>`,
            ),
          );
        }
        if (m.role !== 'owner' && (m.status === 'invited' || m.status === 'invite_expired')) {
          actions.push(post('resend', '<button class="ghost">Resend invite</button>'));
        }
        if (m.role !== 'owner' && current) actions.push(post('remove', '<button class="danger">Remove access</button>'));
        if (m.role !== 'owner' && !current) {
          actions.push(`<small class="mut">To give access again, use the form above.</small>`);
        }
        const until = m.role === 'owner' ? '—' : m.expiresAt ? esc(fmtDate(m.expiresAt)) : 'until removed';
        return `<tr${current || m.role === 'owner' ? '' : ' class="mut"'}><td><b>${esc(m.e164)}</b></td><td>${ROLE_TITLE[m.role]}</td>
          <td>${pill(label, tone)}</td><td><small>${until}</small></td>
          <td><small>${esc(m.grantedVia === 'admin' ? 'support (admin)' : m.grantedVia === 'chat' ? 'owner (WhatsApp)' : 'signup')}<br>${esc(fmtDate(m.since))}</small></td>
          <td><div class="row">${actions.join('')}</div></td></tr>`;
      })
      .join('');

    const body = `
      <p><a href="/admin/tenants">← All businesses</a></p>
      <div class="card"><h2>${esc(t.name)}</h2>
        <div class="kv"><span class="mut">Plan</span><b>${esc(planName(plan))}</b>
        <span class="mut">People</span><span><b>${used}</b> of <b>${seats}</b> in use (owner included)${free === 0 ? ' ' + pill('plan full', 'warn') : ''}</span>
        <span class="mut">Owner WhatsApp</span><span>${esc(t.owner ?? 'not verified yet')}</span>
        <span class="mut">Status</span><span>${pill(t.status, t.status === 'active' ? 'ok' : 'bad')}</span></div>
      </div>

      <div class="card"><h2>Give someone access</h2>
        <form method="post" action="${teamPath(t.id)}/invite">${csrfField(token)}
          <label for="phone">1. Their WhatsApp number</label>
          <input id="phone" name="phone" required placeholder="98XXXXXXXX" inputmode="tel" maxlength="20" autocomplete="off">
          <small>Must be a WhatsApp number that is not already using HisabKitab for another business.</small>
          <label>2. What can they do?</label>${roleCards}
          <label for="access">3. For how long?</label>
          <select id="access" name="access">${accessOptions(false, '30')}</select>
          <label class="opt"><input type="checkbox" name="override" value="1">
            <span><b>Testing or support access</b><br><small>Allow this even if the plan is full or does not include this role. Recorded in the activity log.</small></span></label>
          <p><button>Send invite</button></p>
        </form>
        <div class="flash muted"><b>What happens next:</b> they get a WhatsApp message from HisabKitab and reply <code>JOIN</code> from that number within ${INVITE_TTL_DAYS} days. Until then they have no access.
          The owner is told on WhatsApp that support changed their team. You can change or remove access here at any time, and it ends automatically on the date you chose.</div>
      </div>

      <div class="card"><h2>Team (${rows.filter((r) => r.status === 'active' || r.status === 'invited').length} current)</h2>
        <table><tr><th>WhatsApp</th><th>Role</th><th>Status</th><th>Access until</th><th>Added by</th><th>Actions</th></tr>
        ${tableRows || '<tr><td colspan="6" class="mut">Nobody yet.</td></tr>'}</table></div>

      <div class="card"><h2>The owner can do the same on WhatsApp</h2>
        <p class="mut">The owner sends these to HisabKitab from their own number:</p>
        <p><code>add 98XXXXXXXX as accountant</code> · <code>add 98XXXXXXXX as auditor for 30 days</code> · <code>change 98XXXXXXXX to viewer</code> · <code>remove 98XXXXXXXX</code> · <code>team</code></p></div>`;
    return h.html(reply, layout({ title: 'Team', path: '/admin/tenants', csrf: token, flash: h.flashOf(req), body }));
  });

  // ---- actions -----------------------------------------------------------------
  app.post('/admin/tenants/:id/team/invite', async (req: Req, reply) => {
    const t = await loadTenant(req);
    if (!t) return h.back(reply, '/admin/tenants', 'bad', 'Business not found.');
    const f = (req.body ?? {}) as Form;
    const path = teamPath(t.id);
    const role = f['role'] as Role | undefined;
    if (!role || !INVITABLE_ROLES.includes(role)) return h.back(reply, path, 'bad', 'Pick what they can do (a role).');
    const days = parseAccess(f['access'], false);
    if (days === undefined || days === 'keep') return h.back(reply, path, 'bad', 'Pick how long the access lasts.');
    const phone = normalizePhone(f['phone'] ?? '');
    if (!phone) return h.back(reply, path, 'bad', 'Enter a valid WhatsApp mobile number, e.g. 98XXXXXXXX.');
    if (phone === t.owner) return h.back(reply, path, 'bad', 'That is the owner\'s own number. The owner already has full access.');
    const override = f['override'] === '1';

    const res = await inviteMember(h.db, { via: 'admin', tenantId: t.id, overridePlan: override }, phone, role, { days });
    const ip = h.clientIp(req);
    switch (res.kind) {
      case 'invited': {
        let sent = '';
        try {
          await h.sendTemplate(res.inviteE164, 'team_invite', [res.businessName, res.role]);
          sent = `Invite sent on WhatsApp to ${res.inviteE164}.`;
        } catch (err) {
          sent = `Invite saved, but WhatsApp did not deliver it (${String(err).slice(0, 120)}). Ask them to send JOIN to the HisabKitab number.`;
        }
        await h.event('admin', 'team.invited', { tenant_id: t.id, role, days, override: res.overridden, phone_tail: phone.slice(-4) }, ip);
        const owner = await notifyOwner(
          t,
          `HisabKitab support invited ${withArticle(role)}${days ? ` with access for ${days} days` : ''}`,
          req,
        );
        const until = res.expiresAt ? ` Access ends ${fmtDate(res.expiresAt)}.` : '';
        return h.back(reply, path, 'ok', `${sent} They become ${withArticle(role)} after replying JOIN.${until}${res.overridden ? ' (Plan limit overridden.)' : ''}${owner}`);
      }
      case 'already_member':
        return h.back(reply, path, 'muted', `${phone} is already on this team as ${res.role}. Change it in the table below.`);
      case 'busy_elsewhere':
        return h.back(reply, path, 'bad', `${phone} already uses HisabKitab for another business. One WhatsApp number can only be on one business for now. Use a different number.`);
      case 'seat_limit':
        return h.back(reply, path, 'bad', `The ${planName(res.plan)} plan allows ${res.seats} people and ${res.used} are in use. Remove someone, move the business to a bigger plan, or tick "Testing or support access".`);
      case 'role_not_in_plan':
        return h.back(reply, path, 'bad', `${ROLE_TITLE[res.role]} needs the ${res.minPlan ? planName(res.minPlan) : 'a higher'} plan (this business is on ${planName(res.plan)}). Pick another role, or tick "Testing or support access".`);
      case 'tenant_inactive':
        return h.back(reply, path, 'bad', 'This business is not active, so nobody can be added yet.');
      default:
        return h.back(reply, path, 'bad', 'Check the number, role and access length and try again.');
    }
  });

  app.post('/admin/tenants/:id/team/update', async (req: Req, reply) => {
    const t = await loadTenant(req);
    if (!t) return h.back(reply, '/admin/tenants', 'bad', 'Business not found.');
    const f = (req.body ?? {}) as Form;
    const path = teamPath(t.id);
    const role = f['role'] as Role | undefined;
    if (!role || !INVITABLE_ROLES.includes(role)) return h.back(reply, path, 'bad', 'Pick a role.');
    const access = parseAccess(f['access'], true);
    if (access === undefined) return h.back(reply, path, 'bad', 'Pick how long the access lasts.');
    const res = await changeMember(h.db, { via: 'admin', tenantId: t.id }, f['phone'] ?? '', {
      role,
      ...(access === 'keep' ? {} : { days: access }),
    });
    switch (res.kind) {
      case 'changed': {
        await h.event('admin', 'team.changed', { tenant_id: t.id, role, access, phone_tail: res.e164.slice(-4) }, h.clientIp(req));
        const owner = await notifyOwner(
          t,
          `HisabKitab support changed a team member's access (now ${withArticle(res.role)}${res.expiresAt ? `, until ${fmtDate(res.expiresAt).slice(0, 10)}` : ''})`,
          req,
        );
        return h.back(reply, path, 'ok', `${res.e164} is now ${withArticle(res.role)}${res.expiresAt ? ` until ${fmtDate(res.expiresAt)}` : ' until removed'}.${owner}`);
      }
      case 'role_not_in_plan':
        return h.back(reply, path, 'bad', `${ROLE_TITLE[res.role]} needs the ${res.minPlan ? planName(res.minPlan) : 'a higher'} plan.`);
      case 'not_found':
        return h.back(reply, path, 'bad', 'That person is no longer on the team (access ended or removed). Invite them again.');
      case 'is_owner':
        return h.back(reply, path, 'bad', 'The owner cannot be changed here.');
      default:
        return h.back(reply, path, 'bad', 'Could not save that change.');
    }
  });

  app.post('/admin/tenants/:id/team/remove', async (req: Req, reply) => {
    const t = await loadTenant(req);
    if (!t) return h.back(reply, '/admin/tenants', 'bad', 'Business not found.');
    const path = teamPath(t.id);
    const res = await removeMember(h.db, { via: 'admin', tenantId: t.id }, ((req.body ?? {}) as Form)['phone'] ?? '');
    switch (res.kind) {
      case 'removed': {
        await h.event('admin', 'team.removed', { tenant_id: t.id, role: res.role, phone_tail: res.e164.slice(-4) }, h.clientIp(req));
        const owner = await notifyOwner(t, `HisabKitab support removed access for ${withArticle(res.role)}`, req);
        return h.back(reply, path, 'ok', `${res.e164} no longer has access. Their next message is refused.${owner}`);
      }
      case 'is_owner':
        return h.back(reply, path, 'bad', 'The owner cannot be removed.');
      default:
        return h.back(reply, path, 'bad', 'That person is not on the team.');
    }
  });

  app.post('/admin/tenants/:id/team/resend', async (req: Req, reply) => {
    const t = await loadTenant(req);
    if (!t) return h.back(reply, '/admin/tenants', 'bad', 'Business not found.');
    const path = teamPath(t.id);
    const res = await refreshInvite(h.db, { via: 'admin', tenantId: t.id }, ((req.body ?? {}) as Form)['phone'] ?? '');
    if (res.kind === 'seat_limit') {
      return h.back(reply, path, 'bad', 'The plan is full now, so this old invite cannot be re-opened. Remove someone or invite again with "Testing or support access".');
    }
    if (res.kind !== 'refreshed') return h.back(reply, path, 'bad', 'No open invite for that number.');
    await h.event('admin', 'team.invite_resent', { tenant_id: t.id, phone_tail: res.e164.slice(-4) }, h.clientIp(req));
    try {
      await h.sendTemplate(res.e164, 'team_invite', [t.name, res.role]);
      return h.back(reply, path, 'ok', `Invite sent again to ${res.e164}. It stays open for ${INVITE_TTL_DAYS} days.`);
    } catch (err) {
      return h.back(reply, path, 'warn', `Invite re-opened, but WhatsApp did not deliver it (${String(err).slice(0, 120)}). Ask them to send JOIN.`);
    }
  });
}
