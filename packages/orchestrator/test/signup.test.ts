/**
 * Self-serve signup + number-bound verification codes, against REAL Postgres as
 * hisab_orch. Happy path + PROBES: code used from another number, brute force,
 * resend revokes, per-number + daily limits, bot honeypot, send failure, races,
 * already-registered numbers, and the trial created on verification.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import { classifySendFailure, handleSignup, isOwnSender, type SignupDeps } from '../src/signup/signup.js';
import { WaError, parseMetaErrorCode } from '../src/whatsapp/wa-client.js';
import { handleUnknownSender } from '../src/onboarding/pairing.js';
import { ORCH_URL } from './urls.js';

let orch: DbHandle;
beforeAll(() => {
  orch = createDb(ORCH_URL, 4);
});
afterAll(async () => {
  await orch.close();
});

let seq = 0;
/** A fresh, never-used Nepali mobile per test (tests share one database). */
const freshPhone = () => `98${String(70_000_000 + (Date.now() % 1_000_000) * 10 + (seq += 1)).slice(-8)}`;
const e164 = (local: string) => `+977${local}`;

function deps(over: Partial<SignupDeps> = {}, sent: { to: string; template: string; code?: string; params?: string[] }[] = []) {
  const d: SignupDeps = {
    db: orch.db,
    sendAuthCode: vi.fn(async (to: string, template: string, code: string) => {
      sent.push({ to, template, code });
    }),
    sendTemplate: vi.fn(async (to: string, template: string, params: string[]) => {
      sent.push({ to, template, params });
    }),
    settings: {
      enabled: () => true,
      dailyCap: () => 10_000,
      senderE164: () => '+9779745861381',
      alertE164: () => '+9779800000001',
    },
    ...over,
  };
  return { d, sent };
}

const form = (phone: string, extra: Record<string, unknown> = {}) => ({
  business_name: 'Sharma Traders',
  owner_name: 'Ram Sharma',
  whatsapp: phone,
  pan_vat: '601234567',
  consent: true,
  ...extra,
});

describe('POST /signup core (handleSignup)', () => {
  it('creates a pending business, sends a 6-digit code to the claimed number, alerts the admin', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    const r = await handleSignup(d, form(phone));
    expect(r).toMatchObject({
      status: 'code_sent',
      sender_e164: '+9779745861381',
      wa_link: 'https://wa.me/9779745861381?text=START%20',
    });
    const code = sent.find((s) => s.template === 'pairing_code');
    expect(code?.to).toBe(e164(phone));
    expect(code?.code).toMatch(/^\d{6}$/);
    expect(sent.some((s) => s.template === 'admin_account_update' && s.to === '+9779800000001')).toBe(true);

    const [row] = await orch.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.code, code!.code!));
    expect(row?.phoneE164).toBe(e164(phone));
    const [t] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, row!.tenantId));
    expect(t).toMatchObject({ status: 'pending', signupSource: 'web', ownerName: 'Ram Sharma', whatsappE164: null });
    // the response NEVER carries the code
    expect(JSON.stringify(r)).not.toContain(code!.code!);
  });

  it('verification FROM the bound number activates the business + starts the trial', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const code = sent.find((s) => s.template === 'pairing_code')!.code!;
    const out = await handleUnknownSender(orch.db, e164(phone), `START ${code}`, { trialPlan: 'pro' });
    expect(out.kind).toBe('paired');
    const tenantId = (out as { tenantId: string }).tenantId;
    const [t] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(t).toMatchObject({ status: 'active', whatsappE164: e164(phone) });
    const [sub] = await orch.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId));
    expect(sub).toMatchObject({ planCode: 'pro', status: 'trial' });
  });

  it('a pasted bare 6-digit code from the bound number also verifies', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const code = sent.find((s) => s.template === 'pairing_code')!.code!;
    expect((await handleUnknownSender(orch.db, e164(phone), ` ${code} `)).kind).toBe('paired');
  });

  it('PROBE: the code is useless from any other number (and the probe learns nothing)', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const code = sent.find((s) => s.template === 'pairing_code')!.code!;
    const attacker = e164(freshPhone());
    expect(await handleUnknownSender(orch.db, attacker, `START ${code}`)).toEqual({ kind: 'invalid_code' });
    expect(await handleUnknownSender(orch.db, attacker, code)).toEqual({ kind: 'invalid_code' });
    // the real owner can still use it
    expect((await handleUnknownSender(orch.db, e164(phone), `START ${code}`)).kind).toBe('paired');
  });

  it('PROBE: brute force from the bound number burns the code after 5 wrong tries', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const code = sent.find((s) => s.template === 'pairing_code')!.code!;
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i += 1) {
      expect((await handleUnknownSender(orch.db, e164(phone), `START ${wrong}`)).kind).toBe('invalid_code');
    }
    expect((await handleUnknownSender(orch.db, e164(phone), `START ${code}`)).kind).toBe('invalid_code');
  });

  it('resend re-uses the pending business and revokes the previous code', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    await handleSignup(d, form(phone, { business_name: 'Sharma Traders Pvt Ltd' }));
    const codes = sent.filter((s) => s.template === 'pairing_code').map((s) => s.code!);
    expect(codes).toHaveLength(2);
    const rows = await orch.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.phoneE164, e164(phone)));
    expect(new Set(rows.map((r) => r.tenantId)).size).toBe(1); // ONE business, not two
    expect((await handleUnknownSender(orch.db, e164(phone), `START ${codes[0]}`)).kind).toBe('invalid_code');
    const ok = await handleUnknownSender(orch.db, e164(phone), `START ${codes[1]}`);
    expect(ok).toMatchObject({ kind: 'paired', businessName: 'Sharma Traders Pvt Ltd' });
    // only ONE alert for the business, not one per resend
    expect(sent.filter((s) => s.template === 'admin_account_update')).toHaveLength(1);
  });

  it('PROBE: per-number limit (3 codes / 24h) stops template-spend abuse', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    for (let i = 0; i < 3; i += 1) expect((await handleSignup(d, form(phone))).status).toBe('code_sent');
    expect(await handleSignup(d, form(phone))).toEqual({ status: 'rate_limited' });
    expect(sent.filter((s) => s.template === 'pairing_code')).toHaveLength(3);
  });

  it('PROBE: the global daily cap refuses once reached', async () => {
    const { d, sent } = deps({
      settings: { enabled: () => true, dailyCap: () => 0, senderE164: () => undefined, alertE164: () => undefined },
    });
    expect(await handleSignup(d, form(freshPhone()))).toEqual({ status: 'busy' });
    expect(sent).toHaveLength(0);
  });

  it('PROBE: honeypot-filled submission does nothing (but looks successful to the bot)', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    const r = await handleSignup(d, form(phone, { website: 'http://spam.example' }));
    expect(r.status).toBe('code_sent');
    expect(sent).toHaveLength(0);
    const rows = await orch.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.phoneE164, e164(phone)));
    expect(rows).toHaveLength(0);
  });

  it('signup closed → refused without side effects', async () => {
    const { d, sent } = deps({
      settings: { enabled: () => false, dailyCap: () => 100, senderE164: () => undefined, alertE164: () => undefined },
    });
    expect(await handleSignup(d, form(freshPhone()))).toEqual({ status: 'closed' });
    expect(sent).toHaveLength(0);
  });

  it('PROBE: invalid input is rejected field by field', async () => {
    const { d } = deps();
    const r = await handleSignup(d, { ...form('12345'), pan_vat: 'abc', consent: false });
    expect(r.status).toBe('invalid');
    expect(Object.keys((r as { errors: object }).errors).sort()).toEqual(['consent', 'pan_vat', 'whatsapp']);
  });

  it('PROBE: a WhatsApp send failure burns the code (no live code the owner never got)', async () => {
    const phone = freshPhone();
    const { d } = deps({
      sendAuthCode: vi.fn(async () => {
        throw new Error('131026 receiver incapable');
      }),
    });
    expect(await handleSignup(d, form(phone))).toEqual({ status: 'send_failed', reason: 'service' });
    // judged by the DB clock (the same clock pairing uses)
    const live = await orch.db
      .select()
      .from(schema.pairingCodes)
      .where(
        and(
          eq(schema.pairingCodes.phoneE164, e164(phone)),
          isNull(schema.pairingCodes.consumedAt),
          sql`${schema.pairingCodes.expiresAt} > now()`,
        ),
      );
    expect(live).toHaveLength(0);
  });

  const metaFail = (code: number) =>
    vi.fn(async () => {
      throw new WaError(`graph /x/messages → 400: {"error":{"code":${code}}}`, 400, code);
    });

  it('PROBE: undelivered codes (#131030 test-number allow-list) never lock the owner out', async () => {
    // the 2026-10-05 prod incident: 3 refused sends => "Too many attempts" for 24h
    const phone = freshPhone();
    const failing = deps({ sendAuthCode: metaFail(131030) }).d;
    for (let i = 0; i < 5; i += 1) {
      expect(await handleSignup(failing, form(phone))).toEqual({ status: 'send_failed', reason: 'service' });
    }
    // once the sender is fixed, the SAME number gets a code straight away...
    const { d, sent } = deps();
    expect((await handleSignup(d, form(phone))).status).toBe('code_sent');
    const code = sent.find((s) => s.template === 'pairing_code')!.code!;
    // ...still tied to ONE pending business (retries never orphan businesses)
    const rows = await orch.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.phoneE164, e164(phone)));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.tenantId)).size).toBe(1);
    expect(rows.filter((r) => r.sendFailedAt !== null)).toHaveLength(5);
    // the failed codes are dead; only the delivered one pairs (2 probes: 5 wrong
    // tries would trip the brute-force burn, which is separately tested)
    for (const r of rows.filter((x) => x.sendFailedAt !== null).slice(0, 2)) {
      expect(await handleUnknownSender(orch.db, e164(phone), `START ${r.code}`)).toEqual({ kind: 'invalid_code' });
    }
    expect((await handleUnknownSender(orch.db, e164(phone), `START ${code}`)).kind).toBe('paired');
    // the failures are visible to the operator
    const events = await orch.db
      .select()
      .from(schema.adminEvents)
      .where(and(eq(schema.adminEvents.action, 'signup.send_failed'), sql`${schema.adminEvents.detail}->>'phone_tail' = ${phone.slice(-4)}`));
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events[0]!.detail).toMatchObject({ reason: 'service', meta_code: 131030 });
  });

  it('PROBE: delivered codes still hit the 3/24h limit even after earlier failures', async () => {
    const phone = freshPhone();
    await handleSignup(deps({ sendAuthCode: metaFail(131030) }).d, form(phone));
    const { d } = deps();
    for (let i = 0; i < 3; i += 1) expect((await handleSignup(d, form(phone))).status).toBe('code_sent');
    expect(await handleSignup(d, form(phone))).toEqual({ status: 'rate_limited' });
  });

  it('PROBE: undelivered codes do not consume the global daily cap', async () => {
    const before = await orch.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.pairingCodes)
      .where(and(isNotNull(schema.pairingCodes.phoneE164), isNull(schema.pairingCodes.sendFailedAt), sql`${schema.pairingCodes.createdAt} > now() - interval '1 day'`));
    const cap = before[0]!.n + 1; // exactly one delivered code left today
    const settings = { enabled: () => true, dailyCap: () => cap, senderE164: () => undefined, alertE164: () => undefined };
    for (let i = 0; i < 3; i += 1) {
      expect((await handleSignup(deps({ settings, sendAuthCode: metaFail(131030) }).d, form(freshPhone()))).status).toBe('send_failed');
    }
    expect((await handleSignup(deps({ settings }).d, form(freshPhone()))).status).toBe('code_sent');
    expect(await handleSignup(deps({ settings }).d, form(freshPhone()))).toEqual({ status: 'busy' });
  });

  it('a number that cannot receive WhatsApp is reported as the recipient, not our fault', async () => {
    expect(await handleSignup(deps({ sendAuthCode: metaFail(131026) }).d, form(freshPhone()))).toEqual({
      status: 'send_failed',
      reason: 'recipient',
    });
    expect(classifySendFailure(new WaError('x', 400, 131021))).toBe('recipient');
  });

  it('PROBE: unknown / token / network failures are classified as OUR problem (never blame the owner)', () => {
    expect(classifySendFailure(new WaError('x', 400, 131030))).toBe('service');
    expect(classifySendFailure(new WaError('x', 401, 190))).toBe('service');
    expect(classifySendFailure(new WaError('x', 500))).toBe('service');
    expect(classifySendFailure(new Error('ECONNRESET'))).toBe('service');
    expect(classifySendFailure('131026')).toBe('service'); // a string is not a Meta verdict
  });

  it('an already-active number is told to just message us (no new business)', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const code = sent.find((s) => s.template === 'pairing_code')!.code!;
    await handleUnknownSender(orch.db, e164(phone), `START ${code}`);
    const r = await handleSignup(d, form(phone));
    expect(r).toMatchObject({ status: 'already_registered', wa_link: 'https://wa.me/9779745861381?text=START%20' });
  });

  it('PROBE: 6 concurrent submissions for one number create exactly ONE business', async () => {
    const phone = freshPhone();
    const { d } = deps();
    const results = await Promise.all(Array.from({ length: 6 }, () => handleSignup(d, form(phone))));
    expect(results.filter((r) => r.status === 'code_sent')).toHaveLength(3); // per-number limit holds under race
    expect(results.filter((r) => r.status === 'rate_limited')).toHaveLength(3);
    const rows = await orch.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.phoneE164, e164(phone)));
    expect(new Set(rows.map((r) => r.tenantId)).size).toBe(1);
  });
});

describe('parseMetaErrorCode', () => {
  it('reads error.code from a real Graph body', () => {
    expect(
      parseMetaErrorCode('{"error":{"message":"(#131030) Recipient phone number not in allowed list","code":131030}}'),
    ).toBe(131030);
  });
  it('PROBE: garbage / truncated / non-numeric bodies yield undefined, never a wrong code', () => {
    expect(parseMetaErrorCode('<html>502</html>')).toBeUndefined();
    expect(parseMetaErrorCode('{"error":{"code":"131026"}}')).toBeUndefined();
    expect(parseMetaErrorCode('{"error":{"message":"x","code":1310')).toBeUndefined();
    expect(parseMetaErrorCode('')).toBeUndefined();
  });
});

describe('own-sender guard', () => {
  it("PROBE: signing up with HisabKitab's own sender number is refused, in any format, with no code sent", async () => {
    for (const n of ['9745861381', '+977 974-586-1381', '+9779745861381']) {
      const { d, sent } = deps();
      const r = await handleSignup(d, form(n));
      expect(r.status, n).toBe('invalid');
      expect((r as { errors: Record<string, string> }).errors.whatsapp).toMatch(/own WhatsApp number/);
      expect(sent).toHaveLength(0);
    }
  });

  it('isOwnSender: digit-exact, and never true when no sender is configured', () => {
    expect(isOwnSender('+9779745861381', '+977 9745861381')).toBe(true);
    expect(isOwnSender('+9779745861382', '+9779745861381')).toBe(false);
    expect(isOwnSender('+9779745861381', undefined)).toBe(false);
    expect(isOwnSender('', '')).toBe(false);
  });
});
