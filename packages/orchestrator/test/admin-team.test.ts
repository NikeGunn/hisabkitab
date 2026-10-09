/**
 * Admin panel → Businesses → Team, over the REAL Fastify server + REAL Postgres.
 * Fixtures: a paired Pro business. Invariants: the invitee is never active until
 * they JOIN; the owner is told on WhatsApp about every support change; plan limits
 * hold unless the operator explicitly overrides them. PROBES: no session, no CSRF,
 * cross-origin, owner's own number, malformed tenant id, script in the business
 * name, a phone/role/access value outside the allowlist, a full plan.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { createDb, schema, SettingsCache, __setPiiKeyForTests, type DbHandle } from '@hisab/db';
import { buildServer } from '../src/server.js';
import { registerAdmin } from '../src/admin/routes.js';
import { AdminAuth, hashPassword } from '../src/admin/auth.js';
import { acceptInvite, resolveMembership } from '../src/identity/membership.js';
import { handleUnknownSender, issuePairingCode } from '../src/onboarding/pairing.js';
import type { RouterDeps } from '../src/whatsapp/router.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

const PASSWORD = 'team page password';
const n = (i: number) => `+97798000902${String(i).padStart(2, '0')}`;
const OWNER = n(1);
let orch: DbHandle;
let adminDb: DbHandle;
let app: FastifyInstance;
let settings: SettingsCache;
let tenantId: string;
const sent: { to: string; template: string; params: string[] }[] = [];
let failTemplate: string | null = null;

beforeAll(async () => {
  __setPiiKeyForTests(randomBytes(32));
  orch = createDb(ORCH_URL, 4);
  adminDb = createDb(ADMIN_URL, 2);
  // Other files leave settings encrypted under THEIR random key; start clean (files run serially).
  await adminDb.db.delete(schema.appSettings);
  settings = await new SettingsCache(orch.db, { WA_PHONE_NUMBER_ID: '1111111111' }).start(60_000);
  const auth = new AdminAuth('team-signing-secret', await hashPassword(PASSWORD));
  app = buildServer({
    verifyToken: () => 'x',
    appSecret: () => 'y',
    acceptsPhoneNumberId: () => true,
    awaitProcessing: true,
    deps: {} as RouterDeps,
    register: (s) =>
      registerAdmin(s, {
        db: orch.db,
        settings,
        auth,
        sendAuthCode: async () => undefined,
        sendTemplate: async (to, template, params) => {
          if (failTemplate === template) throw new Error(`${template} refused by Meta`);
          sent.push({ to, template, params });
        },
        signingSecret: 'team-signing-secret',
        agentConfigured: true,
        model: 'claude-test',
        diskUsage: async () => null,
      }),
  });
  const [t] = await adminDb.db
    .insert(schema.tenants)
    .values({ businessName: 'Karki <script>alert(1)</script> Hardware', panOrVatNo: '600090201' })
    .returning({ id: schema.tenants.id });
  tenantId = t!.id;
  const code = await issuePairingCode(orch.db, tenantId);
  await handleUnknownSender(orch.db, OWNER, `START ${code}`);
  await adminDb.db.insert(schema.subscriptions).values({ tenantId, planCode: 'pro', status: 'active', currentPeriodEnd: '2099-01-01' });
});

afterAll(async () => {
  settings?.stop();
  await app?.close();
  await adminDb.db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, tenantId));
  await adminDb.db.delete(schema.memberships).where(eq(schema.memberships.tenantId, tenantId));
  await adminDb.db.delete(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
  await adminDb.db.delete(schema.pairingCodes).where(eq(schema.pairingCodes.tenantId, tenantId));
  await adminDb.db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
  await adminDb.db.delete(schema.users).where(inArray(schema.users.whatsappE164, [1, 2, 3, 4, 5].map(n)));
  await orch.close();
  await adminDb.close();
  __setPiiKeyForTests(null);
});

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/admin/login', headers: FORM, payload: form({ password: PASSWORD }) });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const page = await app.inject({ url: `/admin/tenants/${tenantId}/team`, headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
  return { cookie, csrf };
}

const post = (s: { cookie: string; csrf: string }, action: string, body: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: `/admin/tenants/${tenantId}/team/${action}`,
    headers: { ...FORM, cookie: s.cookie },
    payload: form({ _csrf: s.csrf, ...body }),
  });
const flash = (location: unknown) => new URLSearchParams(String(location).split('?')[1]).get('m') ?? '';

describe('admin Team page', () => {
  it('PROBE: the page and every action need an admin session', async () => {
    const page = await app.inject({ url: `/admin/tenants/${tenantId}/team` });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe('/admin/login');
    for (const action of ['invite', 'update', 'remove', 'resend']) {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/tenants/${tenantId}/team/${action}`,
        headers: FORM,
        payload: form({ phone: n(2), role: 'accountant', access: '30' }),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('PROBE: a missing CSRF token or a cross-origin POST changes nothing', async () => {
    const s = await login();
    const noCsrf = await app.inject({
      method: 'POST',
      url: `/admin/tenants/${tenantId}/team/invite`,
      headers: { ...FORM, cookie: s.cookie },
      payload: form({ phone: n(2), role: 'accountant', access: '30' }),
    });
    expect(noCsrf.statusCode).toBe(403);
    const cross = await app.inject({
      method: 'POST',
      url: `/admin/tenants/${tenantId}/team/invite`,
      headers: { ...FORM, cookie: s.cookie, origin: 'https://evil.example', host: 'api.hisabkitab.pro' },
      payload: form({ _csrf: s.csrf, phone: n(2), role: 'accountant', access: '30' }),
    });
    expect(cross.statusCode).toBe(403);
    expect(await resolveMembership(orch.db, n(2))).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('renders plan + seats, escapes the business name, and lists the owner', async () => {
    const s = await login();
    const page = await app.inject({ url: `/admin/tenants/${tenantId}/team`, headers: { cookie: s.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&#60;script&#62;');
    expect(page.body).toMatch(/<b>1<\/b> of <b>3<\/b> in use/);
    expect(page.body).toContain(OWNER);
    for (const role of ['Accountant', 'Auditor', 'Staff', 'Viewer']) expect(page.body).toContain(`<b>${role}</b>`);
  });

  it('invite: invitee gets team_invite, owner gets team_access_update, access only after JOIN', async () => {
    const s = await login();
    const res = await post(s, 'invite', { phone: '9800090202', role: 'accountant', access: '30' });
    expect(res.statusCode).toBe(303);
    expect(flash(res.headers.location)).toMatch(/Invite sent on WhatsApp to \+9779800090202.*owner was told/);
    expect(sent).toEqual([
      { to: n(2), template: 'team_invite', params: ['Karki <script>alert(1)</script> Hardware', 'accountant'] },
      {
        to: OWNER,
        template: 'team_access_update',
        params: ['Karki <script>alert(1)</script> Hardware', 'HisabKitab support invited an accountant with access for 30 days'],
      },
    ]);
    expect(await resolveMembership(orch.db, n(2))).toBeNull();
    expect(await acceptInvite(orch.db, n(2))).toMatchObject({ kind: 'accepted', role: 'accountant' });
    const [event] = await adminDb.db.select().from(schema.adminEvents).where(eq(schema.adminEvents.action, 'team.invited'));
    expect(event!.detail).toMatchObject({ tenant_id: tenantId, role: 'accountant', days: 30, phone_tail: '0202' });
  });

  it('PROBE: the owner\'s own number, a bad phone, an unknown role or access value are refused', async () => {
    const s = await login();
    sent.length = 0;
    const cases: [Record<string, string>, RegExp][] = [
      [{ phone: OWNER, role: 'viewer', access: '30' }, /owner's own number/],
      [{ phone: '12345', role: 'viewer', access: '30' }, /valid WhatsApp mobile/],
      [{ phone: n(3), role: 'owner', access: '30' }, /Pick what they can do/],
      [{ phone: n(3), role: 'viewer', access: '9999' }, /how long/],
      [{ phone: n(3), role: 'viewer', access: 'keep' }, /how long/],
    ];
    for (const [body, msg] of cases) expect(flash((await post(s, 'invite', body)).headers.location)).toMatch(msg);
    expect(sent).toHaveLength(0);
  });

  it('PROBE: a malformed or unknown tenant id never acts', async () => {
    const s = await login();
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000', "1' or '1'='1"]) {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/tenants/${encodeURIComponent(id)}/team/invite`,
        headers: { ...FORM, cookie: s.cookie },
        payload: form({ _csrf: s.csrf, phone: n(3), role: 'viewer', access: '30' }),
      });
      expect(flash(res.headers.location)).toMatch(/Business not found/);
    }
  });

  it('full plan: refused with plain guidance; the testing/support override lets it through', async () => {
    const s = await login();
    expect((await post(s, 'invite', { phone: n(3), role: 'auditor', access: '7' })).statusCode).toBe(303); // seat 3 of 3
    const full = await post(s, 'invite', { phone: n(4), role: 'viewer', access: '7' });
    expect(flash(full.headers.location)).toMatch(/Pro plan allows 3 people and 3 are in use/);
    const over = await post(s, 'invite', { phone: n(4), role: 'viewer', access: '7', override: '1' });
    expect(flash(over.headers.location)).toMatch(/Plan limit overridden/);
  });

  it('update + remove: role and end date change, removal is immediate, owner notified each time', async () => {
    const s = await login();
    sent.length = 0;
    const upd = await post(s, 'update', { phone: n(2), role: 'viewer', access: 'none' });
    expect(flash(upd.headers.location)).toMatch(/is now a viewer until removed/);
    expect((await resolveMembership(orch.db, n(2)))!.role).toBe('viewer');
    const rm = await post(s, 'remove', { phone: n(2) });
    expect(flash(rm.headers.location)).toMatch(/no longer has access/);
    expect(await resolveMembership(orch.db, n(2))).toBeNull();
    expect(sent.map((x) => x.template)).toEqual(['team_access_update', 'team_access_update']);
    expect(sent[1]!.params[1]).toBe('HisabKitab support removed access for a viewer');
  });

  it('PROBE: the owner can never be changed or removed from the panel', async () => {
    const s = await login();
    expect(flash((await post(s, 'update', { phone: OWNER, role: 'viewer', access: 'keep' })).headers.location)).toMatch(/owner cannot be changed/);
    expect(flash((await post(s, 'remove', { phone: OWNER })).headers.location)).toMatch(/owner cannot be removed/);
    expect((await resolveMembership(orch.db, OWNER))!.role).toBe('owner');
  });

  it('a failed owner notice is surfaced, never silent, and the change still stands', async () => {
    const s = await login();
    failTemplate = 'team_access_update';
    const res = await post(s, 'invite', { phone: n(5), role: 'staff', access: '90', override: '1' });
    failTemplate = null;
    expect(flash(res.headers.location)).toMatch(/owner notice could not be sent.*tell the owner yourself/);
    const [ev] = await adminDb.db.select().from(schema.adminEvents).where(eq(schema.adminEvents.action, 'team.owner_notice_failed'));
    expect(ev).toBeDefined();
    expect(await acceptInvite(orch.db, n(5))).toMatchObject({ kind: 'accepted', role: 'staff' });
  });

  it('resend re-opens an open invite and sends team_invite again', async () => {
    const s = await login();
    sent.length = 0;
    const res = await post(s, 'resend', { phone: n(3) });
    expect(flash(res.headers.location)).toMatch(/Invite sent again/);
    expect(sent).toEqual([{ to: n(3), template: 'team_invite', params: ['Karki <script>alert(1)</script> Hardware', 'auditor'] }]);
    expect(flash((await post(s, 'resend', { phone: n(2) })).headers.location)).toMatch(/No open invite/);
  });

  it('the Businesses list links to the Team page for an active business', async () => {
    const s = await login();
    const list = await app.inject({ url: '/admin/tenants', headers: { cookie: s.cookie } });
    expect(list.body).toContain(`href="/admin/tenants/${tenantId}/team"`);
  });
});
