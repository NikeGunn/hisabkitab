/**
 * Admin panel over the REAL Fastify server + REAL Postgres (hisab_orch). PROBES:
 * no session, wrong password, brute force, missing/forged CSRF, cross-origin POST,
 * secret stored in plaintext, secret echoed back, XSS in a business name, an
 * evil Khalti origin, and the WhatsApp sender filter against another product's number.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createDb, schema, SettingsCache, __setPiiKeyForTests, type DbHandle } from '@hisab/db';
import { buildServer } from '../src/server.js';
import { isSameOriginPost, registerAdmin } from '../src/admin/routes.js';
import { AdminAuth, hashPassword } from '../src/admin/auth.js';
import { drainOutbox, MAX_ATTEMPTS } from '../src/notify/outbox-drain.js';
import { enqueueNotification } from '@hisab/db';
import type { RouterDeps } from '../src/whatsapp/router.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

vi.mock('../src/whatsapp/router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/whatsapp/router.js')>()),
  processInbound: vi.fn().mockResolvedValue(true),
}));
const { processInbound } = await import('../src/whatsapp/router.js');

const PASSWORD = 'correct horse battery staple';
let orch: DbHandle;
let adminDb: DbHandle;
let app: FastifyInstance;
let settings: SettingsCache;
const sentCodes: { to: string; code: string }[] = [];
let failSend: Error | null = null;

beforeAll(async () => {
  __setPiiKeyForTests(randomBytes(32));
  orch = createDb(ORCH_URL, 4);
  adminDb = createDb(ADMIN_URL, 2);
  settings = await new SettingsCache(orch.db, {
    WA_PHONE_NUMBER_ID: '1111111111',
    WA_APP_SECRET: 'app-secret-123',
    WA_WEBHOOK_VERIFY_TOKEN: 'verify-123',
  }).start(60_000);
  const auth = new AdminAuth('signing-secret-xyz', await hashPassword(PASSWORD));
  app = buildServer({
    verifyToken: () => settings.require('wa.webhook_verify_token'),
    appSecret: () => settings.require('wa.app_secret'),
    acceptsPhoneNumberId: (id) => id === settings.get('wa.phone_number_id'),
    awaitProcessing: true,
    deps: {} as RouterDeps,
    register: (s) =>
      registerAdmin(s, {
        db: orch.db,
        settings,
        auth,
        sendAuthCode: async (to, _t, code) => {
          if (failSend) throw failSend;
          sentCodes.push({ to, code });
        },
        sendTemplate: async () => undefined,
        signingSecret: 'signing-secret-xyz',
        agentConfigured: true,
        model: 'claude-test',
      }),
  });
});

afterAll(async () => {
  settings.stop();
  await app.close();
  await orch.close();
  await adminDb.close();
  __setPiiKeyForTests(null);
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/admin/login', headers: FORM, payload: form({ password: PASSWORD }) });
  expect(res.statusCode).toBe(303);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const page = await app.inject({ url: '/admin/settings', headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
  return { cookie, csrf };
}

describe('admin auth', () => {
  it('PROBE: every page redirects to login without a session', async () => {
    for (const url of ['/admin', '/admin/settings', '/admin/tenants', '/admin/events']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin/login');
    }
    const post = await app.inject({ method: 'POST', url: '/admin/settings', headers: FORM, payload: form({ key: 'payments.live', value: 'true' }) });
    expect(post.statusCode).toBe(401);
  });

  it('PROBE: percent-encoded / dot-segment admin paths never skip the auth gate', async () => {
    for (const url of ['/%61dmin/settings', '/admin/%73ettings', '/%61dmin', '/admin/settings/', '/ADMIN/settings']) {
      const res = await app.inject({ url });
      expect([303, 404]).toContain(res.statusCode); // login redirect or no route — never the page
      expect(res.body).not.toContain('WhatsApp (Meta Cloud API)');
    }
    const post = await app.inject({
      method: 'POST',
      url: '/%61dmin/settings',
      headers: FORM,
      payload: form({ key: 'payments.live', value: 'true', action: 'save' }),
    });
    expect([401, 404]).toContain(post.statusCode);
    expect(settings.get('payments.live')).toBe('false');
  });

  it('PROBE: a client-sent X-Forwarded-For cannot dodge the login lockout', async () => {
    // a direct (untrusted) client: its own XFF header must be ignored
    const attempt = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/admin/login',
        remoteAddress: '203.0.113.77',
        headers: { ...FORM, 'x-forwarded-for': `198.51.100.${i}` },
        payload: form({ password: 'nope' }),
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt(i)).statusCode).toBe(401);
    expect((await attempt(99)).statusCode).toBe(429);
  });

  it('PROBE: forged cookie is rejected', async () => {
    const res = await app.inject({ url: '/admin', headers: { cookie: 'hk_admin=eyJzdWIiOiJhZG1pbiIsImV4cCI6OTk5OTk5OTk5OX0.forged' } });
    expect(res.statusCode).toBe(303);
  });

  it('PROBE: wrong password fails, and brute force is rate-limited', async () => {
    const bad = (ip: string) =>
      app.inject({ method: 'POST', url: '/admin/login', headers: { ...FORM, 'x-forwarded-for': ip }, payload: form({ password: 'nope' }) });
    expect((await bad('10.9.9.9')).statusCode).toBe(401);
    for (let i = 0; i < 4; i += 1) await bad('10.9.9.9');
    expect((await bad('10.9.9.9')).statusCode).toBe(429);
    // even the right password is refused while limited
    const right = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { ...FORM, 'x-forwarded-for': '10.9.9.9' },
      payload: form({ password: PASSWORD }),
    });
    expect(right.statusCode).toBe(429);
  });

  it('session cookie is HttpOnly + Secure + SameSite=Strict, and pages are no-store/noindex', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/login', headers: FORM, payload: form({ password: PASSWORD }) });
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const { cookie } = await login();
    const page = await app.inject({ url: '/admin', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('PROBE: POST without / with a wrong CSRF token, or cross-origin, is refused', async () => {
    const { cookie, csrf } = await login();
    const base = { key: 'signup.daily_cap', value: '7', action: 'save' };
    const noToken = await app.inject({ method: 'POST', url: '/admin/settings', headers: { ...FORM, cookie }, payload: form(base) });
    expect(noToken.statusCode).toBe(403);
    const wrong = await app.inject({ method: 'POST', url: '/admin/settings', headers: { ...FORM, cookie }, payload: form({ ...base, _csrf: 'x' + csrf.slice(1) }) });
    expect(wrong.statusCode).toBe(403);
    const xorigin = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { ...FORM, cookie, origin: 'https://evil.example', host: 'api.hisabkitab.pro' },
      payload: form({ ...base, _csrf: csrf }),
    });
    expect(xorigin.statusCode).toBe(403);
    expect(settings.get('signup.daily_cap')).toBe('50'); // unchanged
  });
});

describe('admin settings', () => {
  it('a saved secret is encrypted at rest, live immediately, and never echoed back', async () => {
    const { cookie, csrf } = await login();
    const token = 'EAAG-test-system-user-token-ABCD1234wxyz';
    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { ...FORM, cookie },
      payload: form({ key: 'wa.access_token', value: token, action: 'save', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(303);
    expect(settings.get('wa.access_token')).toBe(token);
    const [row] = await adminDb.db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'wa.access_token'));
    expect(row?.value.startsWith('enc:v1:')).toBe(true);
    expect(row?.value).not.toContain(token);
    const page = await app.inject({ url: '/admin/settings', headers: { cookie } });
    expect(page.body).not.toContain(token);
    expect(page.body).toContain('••••wxyz');
    const [ev] = await adminDb.db.select().from(schema.adminEvents).where(eq(schema.adminEvents.action, 'setting.updated'));
    expect(JSON.stringify(ev?.detail)).not.toContain(token);
  });

  it('PROBE: an evil Khalti origin is rejected and the live value is unchanged', async () => {
    const { cookie, csrf } = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { ...FORM, cookie },
      payload: form({ key: 'khalti.origin', value: 'https://evil.example', action: 'save', _csrf: csrf }),
    });
    expect(decodeURIComponent(String(res.headers.location))).toMatch(/t=bad/);
    expect(settings.get('khalti.origin')).toBe('https://dev.khalti.com');
  });

  it('switching Khalti to production is one settings change; reset restores the default', async () => {
    const { cookie, csrf } = await login();
    await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { ...FORM, cookie },
      payload: form({ key: 'khalti.origin', value: 'https://khalti.com', action: 'save', _csrf: csrf }),
    });
    expect(settings.get('khalti.origin')).toBe('https://khalti.com');
    await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { ...FORM, cookie },
      payload: form({ key: 'khalti.origin', action: 'clear', _csrf: csrf }),
    });
    expect(settings.get('khalti.origin')).toBe('https://dev.khalti.com');
  });

  it('PROBE: unknown setting keys are refused', async () => {
    const { cookie, csrf } = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { ...FORM, cookie },
      payload: form({ key: '__proto__', value: 'x', action: 'save', _csrf: csrf }),
    });
    expect(decodeURIComponent(String(res.headers.location)).replace(/\+/g, ' ')).toMatch(/unknown setting/);
  });
});

describe('admin businesses', () => {
  it('creates a business, sends a bound code, and escapes hostile names (XSS probe)', async () => {
    const { cookie, csrf } = await login();
    const evil = '<script>alert(1)</script>Evil Traders';
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { ...FORM, cookie },
      payload: form({ business_name: evil, owner_name: 'Hari', whatsapp: '9845000123', pan_vat: '609876543', vat_registered: '1', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(303);
    expect(sentCodes.at(-1)?.to).toBe('+9779845000123');
    const page = await app.inject({ url: '/admin/tenants', headers: { cookie } });
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&#60;script&#62;');
    const [pc] = await adminDb.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.code, sentCodes.at(-1)!.code));
    expect(pc?.phoneE164).toBe('+9779845000123');
  });
});

describe('webhook sender filter (two products share one Meta app)', () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', 'app-secret-123').update(body).digest('hex')}`;
  const payload = (phoneNumberId: string | undefined, id: string) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                ...(phoneNumberId ? { metadata: { phone_number_id: phoneNumberId } } : {}),
                messages: [{ id, from: '9779800000000', timestamp: '1', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    });

  it('answers messages to OUR number; PROBE: ignores another product’s number and metadata-less messages', async () => {
    vi.mocked(processInbound).mockClear();
    for (const [pid, id] of [
      ['1111111111', 'wamid.ours'],
      ['929495330249072', 'wamid.chatbot'],
      [undefined, 'wamid.nometa'],
    ] as const) {
      const body = payload(pid, id);
      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }
    const handled = vi.mocked(processInbound).mock.calls.map((c) => c[1].waMessageId);
    expect(handled).toEqual(['wamid.ours']);
  });

  it('webhook verify token + signature secret come from runtime settings', async () => {
    const ok = await app.inject({ url: '/webhook?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=42' });
    expect(ok.body).toBe('42');
  });
});

describe('notification outbox', () => {
  it('sends once, retries failures, parks after MAX_ATTEMPTS; dedupe key makes a replay a no-op', async () => {
    const key = `test:${Date.now()}`;
    expect(await enqueueNotification(orch.db, { toE164: '+9779800000002', template: 'payment_received', bodyParams: ['1.00'], dedupeKey: key })).toBe(true);
    expect(await enqueueNotification(orch.db, { toE164: '+9779800000002', template: 'payment_received', bodyParams: ['1.00'], dedupeKey: key })).toBe(false);

    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('graph 500');
    };
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await drainOutbox(orch.db, failing);
    const [row] = await orch.db.select().from(schema.outboundNotifications).where(eq(schema.outboundNotifications.dedupeKey, key));
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(row?.lastError).toContain('graph 500');

    const key2 = `${key}:2`;
    await enqueueNotification(orch.db, { toE164: '+9779800000003', template: 'payment_received', bodyParams: ['2.00'], dedupeKey: key2 });
    const sent: string[] = [];
    await drainOutbox(orch.db, async (to) => {
      sent.push(to);
    });
    await drainOutbox(orch.db, async (to) => {
      sent.push(to);
    });
    expect(sent.filter((t) => t === '+9779800000003')).toHaveLength(1);
    expect(calls).toBe(MAX_ATTEMPTS);
  });
});

// What Chrome ACTUALLY sent on prod (Caddy access log, 2026-10-05): a same-origin
// form POST under Referrer-Policy no-referrer carries `Origin: null`.
const HOST = 'api.hisabkitab.pro';
const BROWSER = { origin: 'null', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', host: HOST };
const ATTACKS: Record<string, Record<string, string>> = {
  'sandboxed attacker iframe (null + cross-site)': { origin: 'null', 'sec-fetch-site': 'cross-site', host: HOST },
  'attacker page': { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', host: HOST },
  'sibling subdomain (same-site)': { origin: 'https://hisabkitab.pro', 'sec-fetch-site': 'same-site', host: HOST },
  'lying Origin vs Fetch Metadata': { origin: `https://${HOST}`, 'sec-fetch-site': 'cross-site', host: HOST },
  'null origin from a non-browser': { origin: 'null', host: HOST },
  'look-alike host': { origin: `https://${HOST}.evil.example`, 'sec-fetch-site': 'same-origin', host: HOST },
  'port-shifted origin': { origin: `https://${HOST}:8443`, host: HOST },
};

describe('isSameOriginPost (pure)', () => {
  it('accepts our own pages: real-browser null+same-origin, exact origin, and token-only clients', () => {
    expect(isSameOriginPost(BROWSER)).toBe(true);
    expect(isSameOriginPost({ origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', host: HOST })).toBe(true);
    expect(isSameOriginPost({ origin: `https://${HOST}`, host: HOST })).toBe(true); // pre-Fetch-Metadata browser
    expect(isSameOriginPost({ host: HOST })).toBe(true); // curl: the CSRF token is still required
  });

  it('PROBE: refuses every cross-origin shape', () => {
    for (const [name, h] of Object.entries(ATTACKS)) {
      expect(isSameOriginPost(h), name).toBe(false);
    }
    expect(isSameOriginPost({ origin: ['null', 'null'], 'sec-fetch-site': 'same-origin', host: HOST })).toBe(false);
    expect(isSameOriginPost({ 'sec-fetch-site': ['same-origin', 'cross-site'], host: HOST })).toBe(false);
    expect(isSameOriginPost({ origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' })).toBe(false); // no Host
  });
});

describe('admin panel from a REAL browser (every POST route)', () => {
  async function pendingTenant(cookie: string, csrf: string, phone: string): Promise<string> {
    const name = `Browser Probe ${phone}`;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { ...FORM, ...BROWSER, cookie },
      payload: form({ business_name: name, owner_name: 'Sita', whatsapp: phone, pan_vat: '609876543', _csrf: csrf }),
    });
    expect(res.statusCode).toBe(303);
    const [t] = await adminDb.db.select().from(schema.tenants).where(eq(schema.tenants.businessName, name));
    return t!.id;
  }
  const flash = (res: { headers: Record<string, unknown> }) =>
    decodeURIComponent(String(res.headers.location ?? '')).replace(/\+/g, ' ');
  const post = (url: string, cookie: string, body: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...FORM, ...BROWSER, cookie }, payload: form(body) });

  it('pages send Referrer-Policy same-origin (so browsers send a real Origin)', async () => {
    const { cookie } = await login();
    for (const url of ['/admin', '/admin/settings', '/admin/tenants', '/admin/events', '/admin/login']) {
      const page = await app.inject({ url, headers: { cookie } });
      expect(page.headers['referrer-policy'], url).toBe('same-origin');
    }
  });

  it('Resend code works from the browser: new code sent, old code revoked, logged (the reported bug)', async () => {
    const { cookie, csrf } = await login();
    const id = await pendingTenant(cookie, csrf, '9845000201');
    const first = sentCodes.at(-1)!.code;
    const res = await post(`/admin/tenants/${id}/resend`, cookie, { _csrf: csrf });
    expect(res.statusCode).toBe(303);
    expect(flash(res)).toMatch(/t=ok/);
    const second = sentCodes.at(-1)!;
    expect(second.to).toBe('+9779845000201');
    expect(second.code).not.toBe(first);
    const live = await adminDb.db
      .select({ code: schema.pairingCodes.code })
      .from(schema.pairingCodes)
      .where(
        and(
          eq(schema.pairingCodes.tenantId, id),
          isNull(schema.pairingCodes.consumedAt),
          sql`${schema.pairingCodes.expiresAt} > now()`,
        ),
      );
    expect(live.map((r) => r.code)).toEqual([second.code]); // exactly one live code
    const [ev] = await adminDb.db
      .select()
      .from(schema.adminEvents)
      .where(and(eq(schema.adminEvents.action, 'tenant.code_resent'), sql`${schema.adminEvents.detail}->>'tenant_id' = ${id}`));
    expect(ev?.detail).toMatchObject({ code_sent: true });
  });

  it('PROBE: Resend when WhatsApp refuses (#131030): admin still gets a usable code that never counts against signup limits', async () => {
    const { cookie, csrf } = await login();
    const id = await pendingTenant(cookie, csrf, '9845000202');
    failSend = new Error('(#131030) Recipient phone number not in allowed list');
    try {
      const res = await post(`/admin/tenants/${id}/resend`, cookie, { _csrf: csrf });
      expect(flash(res)).toMatch(/t=warn/);
      const code = /Code (\d{6})/.exec(flash(res))![1]!;
      const [row] = await adminDb.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.code, code));
      expect(row?.sendFailedAt).not.toBeNull();
      expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now()); // still usable by hand
    } finally {
      failSend = null;
    }
  });

  it('PROBE: Resend refuses an active business, an unknown id and a malformed id', async () => {
    const { cookie, csrf } = await login();
    const id = await pendingTenant(cookie, csrf, '9845000203');
    await adminDb.db.update(schema.tenants).set({ status: 'active' }).where(eq(schema.tenants.id, id));
    for (const target of [id, '00000000-0000-0000-0000-000000000000', 'not-a-uuid', "1'; drop table tenants;--"]) {
      const before = sentCodes.length;
      const res = await post(`/admin/tenants/${encodeURIComponent(target)}/resend`, cookie, { _csrf: csrf });
      expect(flash(res), target).toMatch(/t=bad/);
      expect(sentCodes.length).toBe(before);
    }
  });

  it('suspend then activate from the browser; PROBE: a never-verified business cannot be activated', async () => {
    const { cookie, csrf } = await login();
    const id = await pendingTenant(cookie, csrf, '9845000204');
    const act = (action: string) => post(`/admin/tenants/${id}/${action}`, cookie, { _csrf: csrf });
    expect(flash(await act('activate'))).toMatch(/never verified/);
    expect(flash(await act('suspend'))).toMatch(/t=ok/);
    let [t] = await adminDb.db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    expect(t?.status).toBe('suspended');
    await adminDb.db.update(schema.tenants).set({ whatsappE164: '+9779845000204' }).where(eq(schema.tenants.id, id));
    expect(flash(await act('activate'))).toMatch(/t=ok/);
    [t] = await adminDb.db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    expect(t?.status).toBe('active');
  });

  it('settings save, payment link, Meta buttons and logout all pass the origin gate from the browser', async () => {
    const { cookie, csrf } = await login();
    const ok = await post('/admin/settings', cookie, { key: 'signup.daily_cap', value: '60', action: 'save', _csrf: csrf });
    expect(ok.statusCode).toBe(303);
    expect(settings.get('signup.daily_cap')).toBe('60');
    await post('/admin/settings', cookie, { key: 'signup.daily_cap', action: 'clear', _csrf: csrf });
    expect(settings.get('signup.daily_cap')).toBe('50');
    for (const url of [
      '/admin/whatsapp/subscribe',
      '/admin/whatsapp/sync-templates',
      '/admin/tenants/00000000-0000-0000-0000-000000000000/payment-link',
    ]) {
      const res = await post(url, cookie, { plan: 'pro', _csrf: csrf });
      expect(res.statusCode, url).toBe(303); // reached the handler (a friendly flash), not the 403 gate
      expect(res.body, url).not.toContain('Cross-origin');
    }
    const out = await post('/admin/logout', cookie, { _csrf: csrf });
    expect(out.statusCode).toBe(303);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });

  it('PROBE: every POST route refuses every cross-origin attack shape, even with a valid session + CSRF token', async () => {
    const { cookie, csrf } = await login();
    const id = await pendingTenant(cookie, csrf, '9845000205');
    const routes: [string, Record<string, string>][] = [
      ['/admin/settings', { key: 'payments.live', value: 'true', action: 'save' }],
      ['/admin/tenants', { business_name: 'CSRF Corp', owner_name: 'Eve', whatsapp: '9845000299', pan_vat: '609876543' }],
      [`/admin/tenants/${id}/resend`, {}],
      [`/admin/tenants/${id}/suspend`, {}],
      [`/admin/tenants/${id}/activate`, {}],
      [`/admin/tenants/${id}/payment-link`, { plan: 'pro' }],
      ['/admin/whatsapp/subscribe', {}],
      ['/admin/whatsapp/sync-templates', {}],
      ['/admin/logout', {}],
    ];
    const sentBefore = sentCodes.length;
    for (const [url, body] of routes) {
      for (const [name, h] of Object.entries(ATTACKS)) {
        const res = await app.inject({ method: 'POST', url, headers: { ...FORM, ...h, cookie }, payload: form({ ...body, _csrf: csrf }) });
        expect(res.statusCode, `${url} / ${name}`).toBe(403);
        expect(res.headers['set-cookie'], `${url} / ${name}`).toBeUndefined();
      }
    }
    expect(settings.get('payments.live')).toBe('false');
    expect(sentCodes.length).toBe(sentBefore);
    const [t] = await adminDb.db.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    expect(t?.status).toBe('pending');
    const csrfCorp = await adminDb.db.select().from(schema.tenants).where(eq(schema.tenants.businessName, 'CSRF Corp'));
    expect(csrfCorp).toHaveLength(0);
  });

  it('PROBE: a browser POST without a session, or with a forged CSRF token, is still refused', async () => {
    const { csrf } = await login();
    const noSession = await app.inject({
      method: 'POST',
      url: '/admin/settings',
      headers: { ...FORM, ...BROWSER },
      payload: form({ key: 'payments.live', value: 'true', action: 'save', _csrf: csrf }),
    });
    expect(noSession.statusCode).toBe(401);
    const other = await login();
    const forged = await post('/admin/settings', other.cookie, { key: 'payments.live', value: 'true', action: 'save', _csrf: 'x' + csrf.slice(1) });
    expect(forged.statusCode).toBe(403);
    expect(settings.get('payments.live')).toBe('false');
  });
});

describe('admin create-business guards', () => {
  it("PROBE: refuses our own sender number and a number that already owns a business", async () => {
    const { cookie, csrf } = await login();
    const create = (whatsapp: string, business_name: string) =>
      app.inject({
        method: 'POST',
        url: '/admin/tenants',
        headers: { ...FORM, ...BROWSER, cookie },
        payload: form({ business_name, owner_name: 'Ram', whatsapp, pan_vat: '609876543', _csrf: csrf }),
      });
    const setSender = (value?: string) =>
      app.inject({
        method: 'POST',
        url: '/admin/settings',
        headers: { ...FORM, ...BROWSER, cookie },
        payload: form(value ? { key: 'wa.sender_e164', value, action: 'save', _csrf: csrf } : { key: 'wa.sender_e164', action: 'clear', _csrf: csrf }),
      });
    await setSender('+9779745861381');
    expect(settings.get('wa.sender_e164')).toBe('+9779745861381');
    try {
      const r = await create('974-586-1381', 'Own Sender Co');
      expect(decodeURIComponent(String(r.headers.location)).replace(/\+/g, ' ')).toMatch(/own WhatsApp number/);
      expect(await adminDb.db.select().from(schema.tenants).where(eq(schema.tenants.businessName, 'Own Sender Co'))).toHaveLength(0);
    } finally {
      await setSender();
    }
    const [owner] = await adminDb.db
      .insert(schema.tenants)
      .values({ businessName: 'Owned Already', panOrVatNo: '600000079', whatsappE164: '+9779845000300', status: 'suspended' })
      .returning({ id: schema.tenants.id });
    expect(owner).toBeDefined();
    const before = sentCodes.length;
    const r2 = await create('9845000300', 'Duplicate Owner Co');
    expect(decodeURIComponent(String(r2.headers.location)).replace(/\+/g, ' ')).toMatch(/already active/);
    expect(sentCodes.length).toBe(before);
    expect(await adminDb.db.select().from(schema.tenants).where(eq(schema.tenants.businessName, 'Duplicate Owner Co'))).toHaveLength(0);
  });
});
