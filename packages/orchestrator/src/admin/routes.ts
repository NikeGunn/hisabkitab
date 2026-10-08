/**
 * Private operator panel — /admin on the orchestrator (same origin as the webhook,
 * behind Caddy TLS). Lets the operator run the pilot without a deploy:
 *   - see live health: WhatsApp sender, template approvals, Khalti mode, signups
 *   - edit runtime settings (new WhatsApp number, production Khalti key, …)
 *   - review pilot applications from the website: Approve (owner notified on
 *     WhatsApp) or Decline — nothing is sent to an applicant before Approve
 *   - set up a business by hand (WhatsApp verification code sent + shown once)
 *   - send a Khalti payment link, suspend / reactivate a business
 *   - subscribe the app to a new WhatsApp account + submit missing templates
 *
 * Security: one scrypt-hashed password (ADMIN_PASSWORD_HASH; panel is DISABLED
 * when unset), login rate-limit, HttpOnly+Secure+SameSite=Strict session, CSRF
 * token on every POST, Origin check, no-store + strict CSP + noindex, every action
 * appended to admin_events. Secrets are write-only: the UI never echoes them.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  appendAudit,
  clearSetting,
  encPII,
  saveSetting,
  schema,
  SettingsError,
  type Db,
  type SettingsCache,
} from '@hisab/db';
import {
  PLAN_META,
  SETTINGS,
  formatNpr,
  SETTING_KEYS,
  maskSecret,
  normalizePhone,
  type PlanCode,
  type SettingGroup,
} from '@hisab/shared';
import { AdminAuth, SESSION_COOKIE, parseCookies, sessionCookieHeader, verifyPassword, type AdminSession } from './auth.js';
import { csrfField, esc, fmtDate, layout, pill, type Tone } from './html.js';
import { metaStatus, subscribeApp, syncTemplates, type MetaCreds } from './meta.js';
import { initiateSubscriptionLink } from './payment-link.js';
import { issuePairingCode, PAIRING_TTL_MINUTES } from '../onboarding/pairing.js';
import { PAIRING_TEMPLATE, isOwnSender } from '../signup/signup.js';

export interface AdminDeps {
  db: Db; // hisab_orch
  settings: SettingsCache;
  auth: AdminAuth;
  sendAuthCode(to: string, template: string, code: string): Promise<void>;
  sendTemplate(to: string, template: string, params: string[], button?: string): Promise<void>;
  signingSecret: string;
  /** Payments MCP endpoint for payment links (internal URL). Omitted = links disabled. */
  paymentsMcpUrl?: string;
  /** Our Meta app id (to show whether it is subscribed to the account's webhooks). */
  appId?: string;
  graphBaseUrl?: string;
  fetchImpl?: typeof fetch;
  agentConfigured: boolean;
  model: string;
  now?: () => Date;
}

type Req = FastifyRequest & { admin?: AdminSession };
type Form = Record<string, string | undefined>;

/** WhatsApp template that tells an applicant their pilot application was approved. */
export const APPROVED_TEMPLATE = 'account_approved';

const REVIEW_TONE: Record<'awaiting' | 'approved' | 'declined', Tone> = { awaiting: 'warn', approved: 'ok', declined: 'bad' };

const GROUP_TITLES: Record<SettingGroup, string> = {
  whatsapp: 'WhatsApp (Meta Cloud API)',
  payments: 'Payments (Khalti)',
  signup: 'Website signup',
};

/** Client IP as resolved by Fastify's trustProxy (only the Caddy hop is trusted). */
function clientIp(req: FastifyRequest): string {
  return req.ip;
}

/**
 * Is this state-changing admin POST from our own pages? (Layer 1 of 2; the CSRF
 * token is layer 2 and is always required too.)
 *
 * Fetch Metadata first: every current browser sends `Sec-Fetch-Site`, and only
 * `same-origin` is ours (`same-site` would be another hisabkitab.pro subdomain,
 * `cross-site` an attacker page). `Origin: null` is what Chrome sends on a
 * same-origin form POST under a strict Referrer-Policy — the 2026-10-05 prod bug
 * where every admin button answered "Cross-origin request refused" — so `null`
 * is accepted ONLY when the browser also vouches same-origin (a sandboxed attacker
 * iframe also sends `null`, but with `cross-site`). A concrete Origin must match
 * the Host. Non-browser clients (no Origin, no Sec-Fetch-Site) fall through to
 * the CSRF token, which they cannot obtain without the session.
 */
export function isSameOriginPost(headers: {
  origin?: string | string[] | undefined;
  host?: string | undefined;
  'sec-fetch-site'?: string | string[] | undefined;
}): boolean {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v.length === 1 ? v[0] : 'duplicated-header') : v);
  const site = one(headers['sec-fetch-site']);
  const origin = one(headers.origin);
  if (site !== undefined && site !== 'same-origin') return false;
  if (origin === undefined) return true;
  if (origin === 'null') return site === 'same-origin';
  const host = headers.host;
  return Boolean(host) && (origin === `https://${host}` || origin === `http://${host}`);
}

function securityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('x-frame-options', 'DENY')
    .header('x-robots-tag', 'noindex, nofollow')
    // same-origin (not no-referrer): the browser then sends a real Origin on our
    // own form POSTs, and no URL (flash messages can carry a pairing code) ever
    // leaks to another site.
    .header('referrer-policy', 'same-origin')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
}

function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
  return securityHeaders(reply).code(status).type('text/html; charset=utf-8').send(body);
}

function back(reply: FastifyReply, path: string, tone: Tone, text: string): FastifyReply {
  const q = new URLSearchParams({ t: tone, m: text.slice(0, 400) });
  return securityHeaders(reply).redirect(`${path}?${q.toString()}`, 303);
}

function flashOf(req: FastifyRequest): { tone: Tone; text: string } | undefined {
  const q = req.query as Record<string, string | undefined>;
  const tone = q['t'];
  if (!q['m'] || !tone || !['ok', 'warn', 'bad', 'muted'].includes(tone)) return undefined;
  return { tone: tone as Tone, text: q['m'] };
}

function errText(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => i.message).join('; ');
  return err instanceof Error ? err.message : String(err);
}

export function registerAdmin(root: FastifyInstance, deps: AdminDeps): void {
  // Encapsulated plugin: the auth hook below is bound to exactly the routes
  // registered in here — never to a raw-URL string match (a percent-encoded path
  // like /%61dmin/settings routes to the same handler but would slip a string
  // check).
  root.register(async (app) => adminPlugin(app, deps));
}

function adminPlugin(app: FastifyInstance, deps: AdminDeps): void {
  // Brute-force guard: 5 FAILED logins per IP per 15 minutes (a success clears it).
  const failures = new Map<string, { n: number; until: number }>();
  const LOGIN_MAX_FAILURES = 5;
  const LOGIN_WINDOW_MS = 15 * 60_000;
  const now = () => deps.now?.() ?? new Date();
  const lockedOut = (ip: string): boolean => {
    const f = failures.get(ip);
    if (!f) return false;
    if (f.until < now().getTime()) {
      failures.delete(ip);
      return false;
    }
    return f.n >= LOGIN_MAX_FAILURES;
  };
  const recordFailure = (ip: string): void => {
    const f = failures.get(ip);
    const t = now().getTime();
    if (!f || f.until < t) failures.set(ip, { n: 1, until: t + LOGIN_WINDOW_MS });
    else f.n += 1;
  };

  // HTML forms post urlencoded bodies.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const event = (actor: string, action: string, detail: Record<string, unknown>, ip?: string) =>
    deps.db.insert(schema.adminEvents).values({ actor, action, detail, ip: ip ?? null });

  // ---- auth gate for everything under /admin except the login page ----------
  app.addHook('preHandler', async (req: Req, reply) => {
    // Every route in this plugin is an admin route; only the login page is open.
    // routeOptions.url is the MATCHED route pattern, not the raw request path.
    if (req.routeOptions.url === '/admin/login') return;
    const session = deps.auth.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!session) {
      if (req.method === 'GET') return securityHeaders(reply).redirect('/admin/login', 303);
      return html(reply, 'Session expired. Please sign in again.', 401);
    }
    if (req.method === 'POST') {
      if (!isSameOriginPost(req.headers)) {
        return html(reply, 'Cross-origin request refused.', 403);
      }
      if (!deps.auth.checkCsrf(session, (req.body as Form | undefined)?.['_csrf'])) {
        return html(reply, 'Form expired. Go back, reload the page and try again.', 403);
      }
    }
    req.admin = session;
  });

  // ---- login / logout --------------------------------------------------------
  const loginPage = (msg?: string) =>
    layout({
      title: 'Sign in',
      path: '/admin/login',
      flash: msg ? { tone: 'bad', text: msg } : undefined,
      body: `<div class="card" style="max-width:380px"><form method="post" action="/admin/login">
        <label for="pw">Admin password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
        <p><button>Sign in</button></p></form></div>`,
    });

  app.get('/admin/login', async (_req, reply) => html(reply, loginPage()));

  app.post('/admin/login', async (req, reply) => {
    const ip = clientIp(req);
    if (lockedOut(ip)) {
      await event('anonymous', 'login.rate_limited', {}, ip);
      return html(reply, loginPage('Too many attempts. Wait 15 minutes and try again.'), 429);
    }
    const password = (req.body as Form | undefined)?.['password'] ?? '';
    const ok = password.length > 0 && (await verifyPassword(password, deps.auth.passwordHash));
    if (!ok) {
      recordFailure(ip);
      await event('anonymous', 'login.failed', {}, ip);
      return html(reply, loginPage('Wrong password.'), 401);
    }
    failures.delete(ip);
    const { cookie } = deps.auth.issue('admin');
    await event('admin', 'login.ok', {}, ip);
    return securityHeaders(reply).header('set-cookie', sessionCookieHeader(cookie)).redirect('/admin', 303);
  });

  app.post('/admin/logout', async (req: Req, reply) => {
    await event('admin', 'logout', {}, clientIp(req));
    return securityHeaders(reply).header('set-cookie', sessionCookieHeader('', 0)).redirect('/admin/login', 303);
  });

  // Defence in depth: a handler can never render/act without a verified session.
  const csrf = (req: Req) => {
    if (!req.admin) throw new Error('admin session missing');
    return deps.auth.csrfToken(req.admin);
  };

  const metaCreds = (): MetaCreds | null => {
    const accessToken = deps.settings.get('wa.access_token');
    const phoneNumberId = deps.settings.get('wa.phone_number_id');
    const businessAccountId = deps.settings.get('wa.business_account_id');
    if (!accessToken || !phoneNumberId || !businessAccountId) return null;
    return {
      accessToken,
      phoneNumberId,
      businessAccountId,
      ...(deps.appId ? { appId: deps.appId } : {}),
      ...(deps.graphBaseUrl ? { baseUrl: deps.graphBaseUrl } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
  };

  // ---- overview --------------------------------------------------------------
  app.get('/admin', async (req: Req, reply) => {
    const creds = metaCreds();
    const meta = creds ? await metaStatus(creds) : null;
    const dayAgo = new Date(now().getTime() - 86_400_000);

    const tenantCounts = await deps.db
      .select({ status: schema.tenants.status, n: count() })
      .from(schema.tenants)
      .groupBy(schema.tenants.status);
    const subCounts = await deps.db
      .select({ status: schema.subscriptions.status, n: count() })
      .from(schema.subscriptions)
      .groupBy(schema.subscriptions.status);
    const [codes24h] = await deps.db
      .select({ n: count() })
      .from(schema.pairingCodes)
      .where(and(sql`${schema.pairingCodes.phoneE164} is not null`, gt(schema.pairingCodes.createdAt, dayAgo)));
    const [awaiting] = await deps.db
      .select({ n: count() })
      .from(schema.tenants)
      .where(and(eq(schema.tenants.status, 'pending'), eq(schema.tenants.reviewStatus, 'awaiting')));
    const outbox = await deps.db
      .select({ status: schema.outboundNotifications.status, n: count() })
      .from(schema.outboundNotifications)
      .groupBy(schema.outboundNotifications.status);

    const kv = (rows: { status: string; n: number }[]) =>
      rows.length ? rows.map((r) => `${esc(r.status)}: <b>${r.n}</b>`).join(' · ') : '<span class="mut">none yet</span>';

    const tplRows = meta
      ? meta.templatesError
        ? `<tr><td colspan="3">${pill('BLOCKED', 'bad')} ${esc(meta.templatesError)}</td></tr>`
        : meta.templates
            .map((t) => {
              const tone: Tone = t.status === 'APPROVED' ? 'ok' : t.status === 'PENDING' ? 'warn' : 'bad';
              // MARKETING bills at the top rate; the send-time guard refuses it, so flag it loudly.
              const cat = t.category
                ? pill(t.category, t.category === 'MARKETING' ? 'bad' : 'muted') +
                  (t.category === 'MARKETING' ? ' <small>blocked from sending: reword under a new name</small>' : '')
                : '';
              return `<tr><td><code>${esc(t.name)}</code></td><td>${pill(t.status, tone)} ${t.reason ? `<small>${esc(t.reason)}</small>` : ''}</td><td>${cat}</td></tr>`;
            })
            .join('')
      : '';

    const phone = meta?.phone;
    const waCard = !creds
      ? `<p>${pill('NOT CONFIGURED', 'bad')} Set the WhatsApp settings first.</p>`
      : `<div class="kv">
          <span class="mut">Number</span><span>${phone ? `<b>${esc(phone.display)}</b> (${esc(phone.name)})` : pill('BLOCKED', 'bad') + ' ' + esc(meta?.phoneError ?? '')}</span>
          <span class="mut">Status</span><span>${phone ? pill(phone.status, phone.status === 'CONNECTED' ? 'ok' : 'bad') : ''}</span>
          <span class="mut">Quality / tier</span><span>${phone ? `${esc(phone.quality)} · ${esc(phone.tier)}` : ''}</span>
          <span class="mut">Display name</span><span>${phone ? pill(phone.nameStatus || 'UNKNOWN', phone.nameStatus === 'APPROVED' ? 'ok' : 'warn') : ''}</span>
          <span class="mut">Webhook subscription</span><span>${
            meta?.appSubscribed === undefined ? pill('UNKNOWN', 'muted') : meta.appSubscribed ? pill('SUBSCRIBED', 'ok') : pill('NOT SUBSCRIBED', 'bad')
          }</span>
        </div>
        <div class="row" style="margin-top:10px">
          <form method="post" action="/admin/whatsapp/subscribe">${csrfField(csrf(req))}<button class="ghost">Subscribe webhooks</button></form>
          <form method="post" action="/admin/whatsapp/sync-templates">${csrfField(csrf(req))}<button class="ghost">Submit missing templates</button></form>
        </div>`;

    const khaltiOrigin = deps.settings.get('khalti.origin') ?? '';
    const prod = khaltiOrigin === 'https://khalti.com';
    const live = deps.settings.bool('payments.live');
    const keySet = Boolean(deps.settings.get('khalti.secret_key'));

    const body = `
      <div class="grid">
        <div class="card"><h2>Businesses</h2><p>${kv(tenantCounts)}</p><p class="mut">Subscriptions: ${kv(subCounts)}</p><a href="/admin/tenants">Manage →</a></div>
        <div class="card"><h2>Signup</h2><p>${deps.settings.bool('signup.enabled') ? pill('OPEN', 'ok') : pill('CLOSED', 'warn')} ${
          deps.settings.bool('signup.require_approval') ? pill('REVIEW FIRST', 'muted') : pill('INSTANT CODE', 'muted')
        }</p>
          <p>Applications awaiting review: <b>${awaiting?.n ?? 0}</b>${(awaiting?.n ?? 0) > 0 ? ' · <a href="/admin/tenants#applications">Review →</a>' : ''}</p>
          <p>Codes sent (24h): <b>${codes24h?.n ?? 0}</b> / ${esc(deps.settings.get('signup.daily_cap'))}</p>
          <p class="mut">Public number: ${esc(deps.settings.get('wa.sender_e164') || 'not set')}</p></div>
        <div class="card"><h2>Payments</h2>
          <p>${prod ? pill('KHALTI PRODUCTION', 'ok') : pill('KHALTI SANDBOX', 'warn')} ${live ? pill('BILLING LIVE', 'ok') : pill('BILLING PREVIEW', 'muted')}</p>
          <p class="mut">Secret key: ${keySet ? `set (${esc(deps.settings.source('khalti.secret_key'))})` : pill('MISSING', 'bad')}</p></div>
        <div class="card"><h2>Agent</h2><p>${deps.agentConfigured ? pill('CONFIGURED', 'ok') : pill('NO AGENT ID', 'bad')}</p><p class="mut">Model: <code>${esc(deps.model)}</code></p>
          <p class="mut">Receipts outbox: ${kv(outbox)}</p></div>
      </div>
      <div class="card"><h2>WhatsApp sender</h2>${waCard}</div>
      ${meta ? `<div class="card"><h2>Message templates</h2><table><tr><th>Template</th><th>Meta status</th><th>Category</th></tr>${tplRows}</table></div>` : ''}`;
    return html(reply, layout({ title: 'Overview', path: '/admin', csrf: csrf(req), flash: flashOf(req), body }));
  });

  app.post('/admin/whatsapp/subscribe', async (req: Req, reply) => {
    const creds = metaCreds();
    if (!creds) return back(reply, '/admin', 'bad', 'WhatsApp settings are incomplete.');
    try {
      const r = await subscribeApp(creds);
      await event('admin', 'whatsapp.subscribe', { ok: r.ok, waba: creds.businessAccountId }, clientIp(req));
      return back(reply, '/admin', r.ok ? 'ok' : 'bad', r.ok ? 'App subscribed to this account’s webhooks.' : `Meta refused: ${r.detail}`);
    } catch (err) {
      return back(reply, '/admin', 'bad', errText(err));
    }
  });

  app.post('/admin/whatsapp/sync-templates', async (req: Req, reply) => {
    const creds = metaCreds();
    if (!creds) return back(reply, '/admin', 'bad', 'WhatsApp settings are incomplete.');
    try {
      const results = await syncTemplates(creds);
      await event('admin', 'whatsapp.templates_synced', { results: results.map((r) => ({ name: r.name, ok: r.ok })) }, clientIp(req));
      if (results.length === 0) return back(reply, '/admin', 'ok', 'Every required template already exists on this account.');
      const failed = results.filter((r) => !r.ok);
      return back(
        reply,
        '/admin',
        failed.length ? 'warn' : 'ok',
        `Submitted ${results.length - failed.length}/${results.length} templates for review.${failed.length ? ' Failed: ' + failed.map((f) => `${f.name} (${f.detail.slice(0, 120)})`).join('; ') : ''}`,
      );
    } catch (err) {
      return back(reply, '/admin', 'bad', errText(err));
    }
  });

  // ---- settings ----------------------------------------------------------------
  app.get('/admin/settings', async (req: Req, reply) => {
    const groups = (['whatsapp', 'payments', 'signup'] as SettingGroup[])
      .map((g) => {
        const rows = SETTING_KEYS.filter((k) => SETTINGS[k].group === g)
          .map((key) => {
            const def = SETTINGS[key] as (typeof SETTINGS)[typeof key] & { options?: readonly string[] };
            const value = deps.settings.get(key);
            const src = deps.settings.source(key);
            const shown = def.secret ? (value ? maskSecret(value) : '') : (value ?? '');
            const input = def.options
              ? `<select name="value">${def.options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
              : `<input name="value" ${def.secret ? 'type="password" autocomplete="new-password" placeholder="enter a new value"' : `value="${esc(value ?? '')}"`}>`;
            return `<tr><td><b>${esc(def.label)}</b><br><small>${esc(def.help)}</small><br><code>${esc(key)}</code></td>
              <td>${shown ? `<code>${esc(shown)}</code>` : pill('not set', 'bad')}<br>${pill(src, src === 'admin' ? 'ok' : 'muted')}</td>
              <td style="min-width:240px"><form method="post" action="/admin/settings">${csrfField(csrf(req))}<input type="hidden" name="key" value="${esc(key)}">
                ${input}<div class="row" style="margin-top:6px"><button name="action" value="save">Save</button>
                ${src === 'admin' ? `<button class="ghost" name="action" value="clear">Reset</button>` : ''}</div></form></td></tr>`;
          })
          .join('');
        return `<div class="card"><h2>${esc(GROUP_TITLES[g])}</h2><table><tr><th>Setting</th><th>Current</th><th>Change</th></tr>${rows}</table></div>`;
      })
      .join('');
    const body = `<p class="mut">Changes apply to every service within ~10 seconds — no deploy. Secrets are encrypted at rest and never shown again. "Reset" returns a value to the server's deploy-time default.</p>${groups}`;
    return html(reply, layout({ title: 'Settings', path: '/admin/settings', csrf: csrf(req), flash: flashOf(req), body }));
  });

  app.post('/admin/settings', async (req: Req, reply) => {
    const f = (req.body ?? {}) as Form;
    const key = f['key'] ?? '';
    try {
      if (f['action'] === 'clear') {
        await clearSetting(deps.db, key, 'admin', clientIp(req));
        await deps.settings.refresh();
        return back(reply, '/admin/settings', 'ok', `${key} reset to its default.`);
      }
      const value = f['value'] ?? '';
      if (value === '' && SETTINGS[key as keyof typeof SETTINGS]?.secret) {
        return back(reply, '/admin/settings', 'muted', 'No new value entered — secret unchanged.');
      }
      await saveSetting(deps.db, key, value, 'admin', clientIp(req));
      await deps.settings.refresh();
      return back(reply, '/admin/settings', 'ok', `Saved ${key}. Live within seconds.`);
    } catch (err) {
      const msg = err instanceof SettingsError || err instanceof ZodError ? errText(err) : `Could not save: ${errText(err)}`;
      return back(reply, '/admin/settings', 'bad', `${key}: ${msg}`);
    }
  });

  // ---- businesses ----------------------------------------------------------------
  app.get('/admin/tenants', async (req: Req, reply) => {
    const rows = await deps.db
      .select({
        id: schema.tenants.id,
        name: schema.tenants.businessName,
        owner: schema.tenants.ownerName,
        email: schema.tenants.contactEmail,
        e164: schema.tenants.whatsappE164,
        status: schema.tenants.status,
        source: schema.tenants.signupSource,
        created: schema.tenants.createdAt,
        review: schema.tenants.reviewStatus,
        applicant: schema.tenants.applicantE164,
        vat: schema.tenants.vatRegistered,
        plan: schema.subscriptions.planCode,
        subStatus: schema.subscriptions.status,
        periodEnd: schema.subscriptions.currentPeriodEnd,
        pendingPhone: sql<string | null>`(select pc.phone_e164 from pairing_codes pc where pc.tenant_id = ${schema.tenants.id} and pc.phone_e164 is not null order by pc.created_at desc limit 1)`,
      })
      .from(schema.tenants)
      .leftJoin(schema.subscriptions, eq(schema.subscriptions.tenantId, schema.tenants.id))
      .orderBy(desc(schema.tenants.createdAt))
      .limit(300);

    const planOpts = (Object.keys(PLAN_META) as PlanCode[])
      .map((p) => `<option value="${p}">${esc(PLAN_META[p].name)}</option>`)
      .join('');
    const list = rows
      .map((t) => {
        const tone: Tone = t.status === 'active' ? 'ok' : t.status === 'pending' ? 'warn' : 'bad';
        const phone = t.e164 ?? t.pendingPhone ?? t.applicant;
        const actions: string[] = [];
        const form = (action: string, label: string, cls = 'ghost', extra = '') =>
          `<form method="post" action="/admin/tenants/${esc(t.id)}/${action}">${csrfField(csrf(req))}${extra}<button class="${cls}">${label}</button></form>`;
        if (t.status === 'pending' && t.review === 'declined') actions.push(form('approve', 'Approve'));
        if (t.status === 'pending' && t.review !== 'awaiting' && t.review !== 'declined' && (t.pendingPhone || t.applicant)) {
          actions.push(form('resend', 'Resend code'));
        }
        if (t.status === 'active') {
          actions.push(form('payment-link', 'Send payment link', 'ghost', `<select name="plan" style="width:auto">${planOpts}</select>`));
          actions.push(form('suspend', 'Suspend', 'danger'));
        }
        if (t.status === 'suspended') actions.push(form('activate', 'Reactivate'));
        return `<tr><td><b>${esc(t.name)}</b><br><small>${esc(t.owner ?? '')} ${t.email ? '· ' + esc(t.email) : ''}</small><br><code>${esc(t.id.slice(0, 8))}</code></td>
          <td>${esc(phone ?? '')}</td><td>${pill(t.status, tone)}${t.review && t.status === 'pending' ? ' ' + pill(t.review, REVIEW_TONE[t.review]) : ''}<br><small>${esc(t.source)}</small></td>
          <td>${t.plan ? `${esc(PLAN_META[t.plan as PlanCode]?.name ?? t.plan)} · ${esc(t.subStatus)}<br><small>until ${esc(t.periodEnd)}</small>` : '<span class="mut">—</span>'}</td>
          <td><small>${esc(fmtDate(t.created))}</small></td><td><div class="row">${actions.join('')}</div></td></tr>`;
      })
      .join('');

    const applications = rows.filter((t) => t.status === 'pending' && t.review === 'awaiting');
    const appRows = applications
      .map((t) => {
        const act = (action: string, label: string, cls: string) =>
          `<form method="post" action="/admin/tenants/${esc(t.id)}/${action}">${csrfField(csrf(req))}<button class="${cls}">${label}</button></form>`;
        return `<tr><td><b>${esc(t.name)}</b><br><small>${esc(t.owner ?? '')}${t.email ? ' · ' + esc(t.email) : ''}</small></td>
          <td>${esc(t.applicant ?? '')}</td><td>${t.vat ? pill('VAT', 'ok') : pill('PAN only', 'muted')}</td>
          <td><small>${esc(fmtDate(t.created))}</small></td>
          <td><div class="row">${act('approve', 'Approve', '')}${act('decline', 'Decline', 'danger')}</div></td></tr>`;
      })
      .join('');
    const body = `
      <div class="card" id="applications"><h2>Applications awaiting review (${applications.length})</h2>
        <p class="mut">From the pilot form. Nothing has been sent to these numbers. <b>Approve</b> messages the owner on WhatsApp; their reply activates the business and starts the trial. <b>Decline</b> sends nothing.</p>
        ${applications.length ? `<table><tr><th>Business</th><th>WhatsApp</th><th>Type</th><th>Applied</th><th>Decision</th></tr>${appRows}</table>` : '<p class="mut">No applications waiting.</p>'}
      </div>
      <div class="card"><h2>Set up a business</h2>
        <p class="mut">Creates the business and sends the owner a WhatsApp verification code. The code is also shown to you once, so you can read it out on a call. The owner replies <code>START &lt;code&gt;</code> from that number to activate.</p>
        <form method="post" action="/admin/tenants">${csrfField(csrf(req))}
          <div class="grid">
            <div><label>Business name</label><input name="business_name" required maxlength="120"></div>
            <div><label>Owner name</label><input name="owner_name" required maxlength="80"></div>
            <div><label>Owner WhatsApp</label><input name="whatsapp" required placeholder="98XXXXXXXX"></div>
            <div><label>PAN / VAT number</label><input name="pan_vat" required inputmode="numeric" maxlength="11"></div>
          </div>
          <label><input type="checkbox" name="vat_registered" value="1" checked style="width:auto"> VAT registered</label>
          <p><button>Create &amp; send code</button></p></form></div>
      <div class="card"><h2>Businesses (${rows.length})</h2><table><tr><th>Business</th><th>WhatsApp</th><th>Status</th><th>Plan</th><th>Created</th><th>Actions</th></tr>${list || '<tr><td colspan="6" class="mut">No businesses yet.</td></tr>'}</table></div>`;
    return html(reply, layout({ title: 'Businesses', path: '/admin/tenants', csrf: csrf(req), flash: flashOf(req), body }));
  });

  /** Issue a fresh number-bound code and send it; returns the code for one-time display. */
  async function sendCode(tenantId: string, phone: string): Promise<{ code: string; sent: boolean; error?: string }> {
    const code = await issuePairingCode(deps.db, tenantId, { phoneE164: phone, digits: 6 });
    try {
      await deps.sendAuthCode(phone, PAIRING_TEMPLATE, code);
      return { code, sent: true };
    } catch (err) {
      // The code stays LIVE (the admin reads it to the owner), but it reached no
      // one on WhatsApp, so it must not count against the owner's signup limits.
      await deps.db
        .update(schema.pairingCodes)
        .set({ sendFailedAt: sql`now()` })
        .where(eq(schema.pairingCodes.code, code));
      return { code, sent: false, error: errText(err) };
    }
  }

  app.post('/admin/tenants', async (req: Req, reply) => {
    const f = (req.body ?? {}) as Form;
    const phone = normalizePhone(f['whatsapp'] ?? '');
    const pan = (f['pan_vat'] ?? '').replace(/[\s-]/g, '');
    const name = (f['business_name'] ?? '').replace(/\s+/g, ' ').trim();
    const owner = (f['owner_name'] ?? '').replace(/\s+/g, ' ').trim();
    if (!phone) return back(reply, '/admin/tenants', 'bad', 'Enter a valid WhatsApp mobile number.');
    if (isOwnSender(phone, deps.settings.get('wa.sender_e164'))) {
      return back(reply, '/admin/tenants', 'bad', "That is HisabKitab's own WhatsApp number. Use the owner's number.");
    }
    if (!/^\d{9}$/.test(pan)) return back(reply, '/admin/tenants', 'bad', 'PAN/VAT number must be 9 digits.');
    if (name.length < 2 || name.length > 120 || owner.length < 2 || owner.length > 80) {
      return back(reply, '/admin/tenants', 'bad', 'Business and owner names are required.');
    }
    const [taken] = await deps.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(and(eq(schema.users.whatsappE164, phone), eq(schema.memberships.status, 'active')))
      .limit(1);
    // same rule as web signup: a number that already owns a business (any status)
    const [owned] = await deps.db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.whatsappE164, phone))
      .limit(1);
    if (taken || owned) return back(reply, '/admin/tenants', 'bad', 'That WhatsApp number is already active on a business.');

    const [t] = await deps.db
      .insert(schema.tenants)
      .values({
        businessName: name,
        ownerName: owner,
        panOrVatNo: encPII(pan) as string,
        vatRegistered: f['vat_registered'] === '1',
        signupSource: 'admin',
      })
      .returning({ id: schema.tenants.id });
    const tenantId = t!.id;
    await deps.db.transaction((tx) =>
      appendAudit(tx, tenantId, { actor: 'system', action: 'signup.admin_created', detail: { by: 'admin' } }),
    );
    const r = await sendCode(tenantId, phone);
    await event('admin', 'tenant.created', { tenant_id: tenantId, business: name, code_sent: r.sent }, clientIp(req));
    return back(
      reply,
      '/admin/tenants',
      r.sent ? 'ok' : 'warn',
      r.sent
        ? `Created ${name}. Code ${r.code} sent on WhatsApp to ${phone} (valid ${PAIRING_TTL_MINUTES} min).`
        : `Created ${name}, but WhatsApp delivery failed (${r.error}). Give the owner code ${r.code} (valid ${PAIRING_TTL_MINUTES} min): they send "START ${r.code}" from ${phone}.`,
    );
  });

  const tenantRoute = (suffix: string) => `/admin/tenants/:id/${suffix}`;
  const tenantById = async (id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [t] = await deps.db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    return t ?? null;
  };

  app.post(tenantRoute('resend'), async (req: Req, reply) => {
    const t = await tenantById((req.params as { id: string }).id);
    if (!t || t.status !== 'pending') return back(reply, '/admin/tenants', 'bad', 'Only a pending business can get a new code.');
    const [last] = await deps.db
      .select({ phone: schema.pairingCodes.phoneE164 })
      .from(schema.pairingCodes)
      .where(and(eq(schema.pairingCodes.tenantId, t.id), sql`${schema.pairingCodes.phoneE164} is not null`))
      .orderBy(desc(schema.pairingCodes.createdAt))
      .limit(1);
    if (t.reviewStatus === 'awaiting' || t.reviewStatus === 'declined') {
      return back(reply, '/admin/tenants', 'bad', 'Approve this application first.');
    }
    const resendTo = last?.phone ?? t.applicantE164;
    if (!resendTo) return back(reply, '/admin/tenants', 'bad', 'No WhatsApp number on file for this business.');
    const r = await sendCode(t.id, resendTo);
    await event('admin', 'tenant.code_resent', { tenant_id: t.id, code_sent: r.sent }, clientIp(req));
    return back(
      reply,
      '/admin/tenants',
      r.sent ? 'ok' : 'warn',
      r.sent ? `New code ${r.code} sent to ${resendTo}.` : `WhatsApp delivery failed (${r.error}). Code ${r.code} — read it to the owner.`,
    );
  });

  app.post(tenantRoute('approve'), async (req: Req, reply) => {
    const t = await tenantById((req.params as { id: string }).id);
    if (!t || t.status !== 'pending' || !t.applicantE164 || (t.reviewStatus !== 'awaiting' && t.reviewStatus !== 'declined')) {
      return back(reply, '/admin/tenants', 'bad', 'Only an application waiting for review can be approved.');
    }
    const phone = t.applicantE164;
    // the number may have joined another business since it applied
    const [taken] = await deps.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(and(eq(schema.users.whatsappE164, phone), eq(schema.memberships.status, 'active')))
      .limit(1);
    const [owned] = await deps.db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.whatsappE164, phone))
      .limit(1);
    if (taken || owned) return back(reply, '/admin/tenants', 'bad', `${phone} is already active on another business.`);

    // claim the decision atomically: a double click approves (and messages) once
    const claimed = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.tenants)
        .set({ reviewStatus: 'approved', reviewedAt: sql`now()` })
        .where(
          and(
            eq(schema.tenants.id, t.id),
            eq(schema.tenants.status, 'pending'),
            inArray(schema.tenants.reviewStatus, ['awaiting', 'declined']),
          ),
        )
        .returning({ id: schema.tenants.id });
      if (rows.length === 0) return false;
      await appendAudit(tx, t.id, { actor: 'system', action: 'signup.approved', detail: { by: 'admin' } });
      return true;
    });
    if (!claimed) return back(reply, '/admin/tenants', 'muted', `${t.businessName} was already decided.`);

    // Tell the owner. The approval notice invites a reply (any reply from that
    // number pairs it); if Meta refuses it (e.g. not approved yet) a code goes instead.
    let delivery: string;
    let tone: Tone = 'ok';
    try {
      await deps.sendTemplate(phone, APPROVED_TEMPLATE, [t.businessName]);
      delivery = `${t.businessName} approved. The owner was messaged on WhatsApp at ${phone}; their reply activates the account and starts the trial.`;
    } catch (err) {
      tone = 'warn';
      const r = await sendCode(t.id, phone);
      delivery = r.sent
        ? `${t.businessName} approved. The approval notice could not be sent (${errText(err)}), so code ${r.code} went to ${phone} instead. Any reply from that number activates it.`
        : `${t.businessName} approved, but WhatsApp delivery failed (${r.error}). Ask the owner to message us from ${phone}: any message activates it (or give code ${r.code}).`;
    }
    await event('admin', 'signup.approved', { tenant_id: t.id, business: t.businessName, phone_tail: phone.slice(-4) }, clientIp(req));
    return back(reply, '/admin/tenants', tone, delivery);
  });

  app.post(tenantRoute('decline'), async (req: Req, reply) => {
    const t = await tenantById((req.params as { id: string }).id);
    if (!t || t.status !== 'pending' || t.reviewStatus !== 'awaiting') {
      return back(reply, '/admin/tenants', 'bad', 'Only an application waiting for review can be declined.');
    }
    await deps.db.transaction(async (tx) => {
      await tx
        .update(schema.tenants)
        .set({ reviewStatus: 'declined', reviewedAt: sql`now()` })
        .where(eq(schema.tenants.id, t.id));
      await appendAudit(tx, t.id, { actor: 'system', action: 'signup.declined', detail: { by: 'admin' } });
    });
    await event('admin', 'signup.declined', { tenant_id: t.id, business: t.businessName }, clientIp(req));
    return back(reply, '/admin/tenants', 'muted', `${t.businessName} declined. Nothing was sent to the applicant.`);
  });

  for (const [suffix, status] of [
    ['suspend', 'suspended'],
    ['activate', 'active'],
  ] as const) {
    app.post(tenantRoute(suffix), async (req: Req, reply) => {
      const t = await tenantById((req.params as { id: string }).id);
      if (!t) return back(reply, '/admin/tenants', 'bad', 'Business not found.');
      if (status === 'active' && !t.whatsappE164) {
        return back(reply, '/admin/tenants', 'bad', 'This business never verified a WhatsApp number — resend a code instead.');
      }
      await deps.db.transaction(async (tx) => {
        await tx.update(schema.tenants).set({ status }).where(eq(schema.tenants.id, t.id));
        await appendAudit(tx, t.id, { actor: 'system', action: `tenant.${suffix}`, detail: { by: 'admin' } });
      });
      await event('admin', `tenant.${suffix}`, { tenant_id: t.id }, clientIp(req));
      return back(reply, '/admin/tenants', 'ok', `${t.businessName} is now ${status}.`);
    });
  }

  app.post(tenantRoute('payment-link'), async (req: Req, reply) => {
    const t = await tenantById((req.params as { id: string }).id);
    const plan = (req.body as Form | undefined)?.['plan'] as PlanCode | undefined;
    if (!t || t.status !== 'active' || !t.whatsappE164) return back(reply, '/admin/tenants', 'bad', 'Business must be active.');
    if (!plan || !(plan in PLAN_META)) return back(reply, '/admin/tenants', 'bad', 'Pick a plan.');
    if (!deps.paymentsMcpUrl) return back(reply, '/admin/tenants', 'bad', 'Payments service is not configured on this server.');
    try {
      const r = await initiateSubscriptionLink({
        paymentsMcpUrl: deps.paymentsMcpUrl,
        signingSecret: deps.signingSecret,
        tenantId: t.id,
        planCode: plan,
      });
      if (!r.ok) return back(reply, '/admin/tenants', 'bad', `Payments refused: ${r.reason ?? 'unknown'}`);
      if (r.mode !== 'live' || !r.pidx) {
        return back(reply, '/admin/tenants', 'warn', 'Billing is in preview mode (Settings → Subscription billing live is off). No link was created.');
      }
      const amount = formatNpr(BigInt(r.amount_paisa ?? 0)).replace(/^Rs\s*/, '');
      await deps.sendTemplate(t.whatsappE164, 'payment_link', [r.plan_name ?? PLAN_META[plan].name, amount], r.pidx);
      await event('admin', 'tenant.payment_link_sent', { tenant_id: t.id, plan, pidx: r.pidx }, clientIp(req));
      return back(reply, '/admin/tenants', 'ok', `Payment link for ${PLAN_META[plan].name} sent to ${t.businessName}.`);
    } catch (err) {
      return back(reply, '/admin/tenants', 'bad', `Could not send the link: ${errText(err)}`);
    }
  });

  // ---- activity --------------------------------------------------------------
  app.get('/admin/events', async (req: Req, reply) => {
    const events = await deps.db.select().from(schema.adminEvents).orderBy(desc(schema.adminEvents.id)).limit(200);
    const failed = await deps.db
      .select()
      .from(schema.outboundNotifications)
      .where(eq(schema.outboundNotifications.status, 'failed'))
      .orderBy(desc(schema.outboundNotifications.id))
      .limit(50);
    const pendingCodes = await deps.db
      .select({ n: count() })
      .from(schema.pairingCodes)
      .where(and(isNull(schema.pairingCodes.consumedAt), gt(schema.pairingCodes.expiresAt, now())));
    const body = `
      <div class="card"><h2>Failed WhatsApp notifications</h2>${
        failed.length
          ? `<table><tr><th>When</th><th>Template</th><th>To</th><th>Error</th></tr>${failed
              .map((n) => `<tr><td><small>${esc(fmtDate(n.createdAt))}</small></td><td><code>${esc(n.template)}</code></td><td>…${esc(n.toE164.slice(-4))}</td><td><small>${esc(n.lastError)}</small></td></tr>`)
              .join('')}</table>`
          : '<p class="mut">None.</p>'
      }<p class="mut">Live verification codes outstanding: ${pendingCodes[0]?.n ?? 0}</p></div>
      <div class="card"><h2>Admin & signup activity</h2><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>${events
        .map((e) => `<tr><td><small>${esc(fmtDate(e.createdAt))}</small></td><td>${esc(e.actor)}</td><td><code>${esc(e.action)}</code></td><td><small>${esc(JSON.stringify(e.detail))}</small></td></tr>`)
        .join('')}</table></div>`;
    return html(reply, layout({ title: 'Activity', path: '/admin/events', csrf: csrf(req), flash: flashOf(req), body }));
  });
}

/** Panel disabled (no ADMIN_PASSWORD_HASH): answer 404 so it is not even discoverable. */
export function registerAdminDisabled(app: FastifyInstance): void {
  app.all('/admin', async (_req, reply) => reply.code(404).send('not found'));
  app.all('/admin/*', async (_req, reply) => reply.code(404).send('not found'));
}
