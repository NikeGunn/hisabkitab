/**
 * Onboarding delivery tracker + retrier against REAL Postgres (hisab_orch).
 * Replays the 2026-10-08 incident (code accepted, then 131042 on the webhook) and
 * PROBES the worst cases: out-of-order / duplicate / foreign status webhooks, a
 * receipt after a failure, a business that paired meanwhile, a number that can
 * never receive, exhausted attempts, two retrier workers racing, the account-level
 * circuit breaker (one probe at a time), and the operator's Retry now.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import {
  applyDeliveryStatus,
  dbNow,
  deliverApproval,
  deliverCode,
  retryNow,
  runDeliveryRetries,
  senderDegraded,
  type OnboardingSender,
} from '../src/onboarding/delivery.js';
import { WaError } from '../src/whatsapp/wa-client.js';
import { handleUnknownSender } from '../src/onboarding/pairing.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

let orch: DbHandle;
let admin: DbHandle;
beforeAll(() => {
  orch = createDb(ORCH_URL, 6);
  admin = createDb(ADMIN_URL, 2);
});
afterAll(async () => {
  await orch.close();
  await admin.close();
});
beforeEach(async () => {
  // the retrier and the circuit breaker look at the whole table
  await admin.db.delete(schema.onboardingMessages);
});

type Sent = { to: string; template: string; wamid: string };
/** A fake Graph: hands out wamids; `refuse` makes the NEXT sends throw. */
function fakeSender() {
  const sent: Sent[] = [];
  const refusals: WaError[] = [];
  let n = 0;
  const send = async (to: string, template: string) => {
    const err = refusals.shift();
    if (err) throw err;
    n += 1;
    const wamid = `wamid.${Date.now()}.${Math.random().toString(36).slice(2)}.${n}`;
    sent.push({ to, template, wamid });
    return wamid;
  };
  const sender: OnboardingSender = {
    sendAuthCode: (to, template) => send(to, template),
    sendTemplate: (to, template) => send(to, template),
  };
  return { sender, sent, refuse: (code: number, msg = 'refused') => refusals.push(new WaError(`graph → 400: (#${code}) ${msg}`, 400, code)) };
}

let seq = 0;
async function approvedBusiness(name = 'Kritaat'): Promise<{ id: string; phone: string }> {
  seq += 1;
  const phone = `+9779705${String(100_000 + (Date.now() % 100_000) + seq).slice(-6)}`;
  const [t] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: name, panOrVatNo: '601234567', signupSource: 'web', reviewStatus: 'approved', applicantE164: phone })
    .returning({ id: schema.tenants.id });
  return { id: t!.id, phone };
}
const rowsOf = (tenantId: string) =>
  orch.db.select().from(schema.onboardingMessages).where(eq(schema.onboardingMessages.tenantId, tenantId)).orderBy(schema.onboardingMessages.id);
const failed = (wamid: string, code: number, title = 'x') => ({ waMessageId: wamid, status: 'failed', errors: [{ code, title }] });
const ok = (wamid: string, status: string) => ({ waMessageId: wamid, status, errors: [] });
const MIN = 60_000;

describe('tracking + status merge', () => {
  it('records the accepted send with its wamid and follows sent → delivered → read', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    const r = await deliverApproval(orch.db, f.sender, { tenantId: b.id, phone: b.phone, businessName: 'Kritaat' });
    expect(r).toEqual({ via: 'notice', sent: true });
    const wamid = f.sent[0]!.wamid;
    for (const s of ['sent', 'delivered', 'read']) await applyDeliveryStatus(orch.db, ok(wamid, s));
    const [row] = await rowsOf(b.id);
    expect(row).toMatchObject({ kind: 'approval_notice', waMessageId: wamid, status: 'read', retryAt: null });
  });

  it('PROBE: out-of-order + duplicated webhooks never regress (read, sent, sent, accepted → read)', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'admin_code' });
    const w = f.sent[0]!.wamid;
    for (const s of ['read', 'sent', 'sent', 'accepted', 'delivered']) await applyDeliveryStatus(orch.db, ok(w, s));
    expect((await rowsOf(b.id))[0]!.status).toBe('read');
  });

  it('PROBE: a failure report AFTER delivery is ignored; a receipt after a failure cancels the retry', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'admin_code' });
    await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'admin_code' });
    const [w1, w2] = f.sent.map((s) => s.wamid);
    await applyDeliveryStatus(orch.db, ok(w1!, 'delivered'));
    await applyDeliveryStatus(orch.db, failed(w1!, 131000));
    await applyDeliveryStatus(orch.db, failed(w2!, 131000));
    expect((await rowsOf(b.id))[1]!.retryAt).not.toBeNull();
    await applyDeliveryStatus(orch.db, ok(w2!, 'delivered'));
    const rows = await rowsOf(b.id);
    expect(rows.map((r) => [r.status, r.retryAt])).toEqual([
      ['delivered', null],
      ['delivered', null],
    ]);
  });

  it("PROBE: a status for someone else's message (other product on the shared app) changes nothing", async () => {
    expect(await applyDeliveryStatus(orch.db, failed('wamid.not-ours', 131042))).toBeNull();
    expect(await applyDeliveryStatus(orch.db, ok('wamid.not-ours', 'banana'))).toBeNull();
  });
});

describe('the 2026-10-08 incident, replayed', () => {
  it('notice template missing → code accepted → 131042 on the webhook → retried automatically → delivered', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    f.refuse(132001, 'Template name does not exist in the translation');
    const r = await deliverApproval(orch.db, f.sender, { tenantId: b.id, phone: b.phone, businessName: 'Kritaat' });
    const T = new Date((await dbNow(orch.db)).getTime() + 5); // the webhook report arrives after the send
    expect(r).toMatchObject({ via: 'code', sent: true });
    const codeWamid = f.sent[0]!.wamid;

    // Meta accepted it, then reported the billing failure on the webhook
    expect(await applyDeliveryStatus(orch.db, failed(codeWamid, 131042, 'Business eligibility payment issue'), T)).toBe('failed');
    let rows = await rowsOf(b.id);
    const failedRow = rows.find((x) => x.waMessageId === codeWamid)!;
    expect(failedRow).toMatchObject({ kind: 'approval_code', status: 'failed', errorCode: 131042 });
    const wait = failedRow.retryAt!.getTime() - T.getTime();
    expect(wait).toBeGreaterThanOrEqual(5 * MIN);
    expect(wait).toBeLessThan(10 * MIN);
    const [ev] = await orch.db
      .select()
      .from(schema.adminEvents)
      .where(eq(schema.adminEvents.action, 'onboarding.delivery_failed'))
      .orderBy(schema.adminEvents.id);
    expect(ev).toBeDefined();
    expect(await senderDegraded(orch.db)).toBe(true);

    // not due yet: nothing is resent
    expect((await runDeliveryRetries(orch.db, f.sender, { now: new Date(T.getTime() + 4 * MIN) })).resent).toBe(0);
    // due: exactly one probe, a fresh code to the same number
    const due = await runDeliveryRetries(orch.db, f.sender, { now: new Date(T.getTime() + 11 * MIN) });
    expect(due).toMatchObject({ resent: 1, probing: true });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.to).toBe(b.phone);
    rows = await rowsOf(b.id);
    expect(rows.at(-1)).toMatchObject({ kind: 'approval_code', attempt: 2, status: 'accepted' });
    expect(rows.find((x) => x.waMessageId === codeWamid)!.supersededAt).not.toBeNull();

    // it gets through; the breaker closes
    await applyDeliveryStatus(orch.db, ok(f.sent[1]!.wamid, 'delivered'));
    expect(await senderDegraded(orch.db)).toBe(false);
    // and the owner can pair from that number
    expect((await handleUnknownSender(orch.db, b.phone, 'hi', { trialPlan: 'pro' })).kind).toBe('paired');
  });
});

describe('retrier worst cases', () => {
  it('a template failure reported on the webhook falls back to a code IMMEDIATELY', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    await deliverApproval(orch.db, f.sender, { tenantId: b.id, phone: b.phone, businessName: 'Kritaat' });
    const T = await dbNow(orch.db);
    await applyDeliveryStatus(orch.db, failed(f.sent[0]!.wamid, 132015, 'Template paused'), T);
    const r = await runDeliveryRetries(orch.db, f.sender, { now: new Date(T.getTime() + 1000) });
    expect(r.resent).toBe(1);
    expect(f.sent[1]!.template).toBe('pairing_code'); // not the broken notice again
    expect((await rowsOf(b.id)).at(-1)).toMatchObject({ kind: 'approval_code', attempt: 2 });
  });

  it('PROBE: a business that paired meanwhile gets NOTHING more', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'approval_code' });
    const T = await dbNow(orch.db);
    await applyDeliveryStatus(orch.db, failed(f.sent[0]!.wamid, 131000), T);
    await handleUnknownSender(orch.db, b.phone, 'hello', { trialPlan: 'pro' }); // owner messaged in first
    const r = await runDeliveryRetries(orch.db, f.sender, { now: new Date(T.getTime() + 60 * MIN) });
    expect(r).toMatchObject({ resent: 0, skipped: 1 });
    expect(f.sent).toHaveLength(1);
  });

  it('PROBE: a number that cannot receive (131026) is parked: no retry, ever', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'approval_code' });
    const T = await dbNow(orch.db);
    await applyDeliveryStatus(orch.db, failed(f.sent[0]!.wamid, 131026, 'Message undeliverable'), T);
    expect((await rowsOf(b.id))[0]!.retryAt).toBeNull();
    expect((await runDeliveryRetries(orch.db, f.sender, { now: new Date(T.getTime() + 24 * 60 * MIN) })).resent).toBe(0);
  });

  it(`PROBE: retries stop after attempt 5, even if Meta keeps failing`, async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'approval_code' });
    let t = (await dbNow(orch.db)).getTime();
    for (let i = 0; i < 10; i += 1) {
      await applyDeliveryStatus(orch.db, failed(f.sent.at(-1)!.wamid, 131000), new Date(t));
      t += 3 * 60 * MIN;
      await runDeliveryRetries(orch.db, f.sender, { now: new Date(t) });
    }
    expect(f.sent).toHaveLength(5);
    const rows = await rowsOf(b.id);
    expect(rows.at(-1)).toMatchObject({ attempt: 5, status: 'failed', retryAt: null });
  });

  it('PROBE: two retrier workers racing resend each due row exactly once (SKIP LOCKED)', async () => {
    const f = fakeSender();
    const T = await dbNow(orch.db);
    const biz = await Promise.all([1, 2, 3, 4, 5, 6].map(() => approvedBusiness()));
    for (const b of biz) {
      await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'approval_code' });
      await applyDeliveryStatus(orch.db, failed(f.sent.at(-1)!.wamid, 131000), T);
    }
    // a delivered message AFTER the failures keeps the breaker closed
    const ok1 = await approvedBusiness();
    await deliverCode(orch.db, f.sender, { tenantId: ok1.id, phone: ok1.phone, kind: 'approval_code' });
    await applyDeliveryStatus(orch.db, ok(f.sent.at(-1)!.wamid, 'delivered'), new Date(T.getTime() + 1));
    const before = f.sent.length;
    const later = new Date(T.getTime() + 30 * MIN);
    const [a, c] = await Promise.all([
      runDeliveryRetries(orch.db, f.sender, { now: later, batch: 4 }),
      runDeliveryRetries(orch.db, f.sender, { now: later, batch: 4 }),
    ]);
    const again = await runDeliveryRetries(orch.db, f.sender, { now: later, batch: 4 });
    expect(a.resent + c.resent + again.resent).toBe(6);
    const resentTo = f.sent.slice(before).map((s) => s.to).sort();
    expect(resentTo).toEqual(biz.map((b) => b.phone).sort()); // each business once, none twice
  });

  it('PROBE: circuit breaker — while 131042 is the latest outcome, ONE probe at a time', async () => {
    const f = fakeSender();
    const T = await dbNow(orch.db);
    const biz = await Promise.all([1, 2, 3].map(() => approvedBusiness()));
    for (const b of biz) {
      await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'approval_code' });
      await applyDeliveryStatus(orch.db, failed(f.sent.at(-1)!.wamid, 131042), T);
    }
    const before = f.sent.length;
    const later = new Date(T.getTime() + 15 * MIN);
    const tick1 = await runDeliveryRetries(orch.db, f.sender, { now: later });
    expect(tick1).toMatchObject({ resent: 1, probing: true });
    // probe still in flight (no outcome yet): the next tick sends nothing
    const tick2 = await runDeliveryRetries(orch.db, f.sender, { now: new Date(later.getTime() + 30_000) });
    expect(tick2.resent).toBe(0);
    expect(f.sent.length).toBe(before + 1);
    // the probe is delivered → breaker closes → the rest go out together
    await applyDeliveryStatus(orch.db, ok(f.sent.at(-1)!.wamid, 'delivered'), new Date(later.getTime() + 60_000));
    const tick3 = await runDeliveryRetries(orch.db, f.sender, { now: new Date(later.getTime() + 90_000) });
    expect(tick3).toMatchObject({ resent: 2, probing: false });
  });

  it('a synchronous refusal (Meta says no at send time) is recorded and scheduled too', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    f.refuse(131000);
    const r = await deliverCode(orch.db, f.sender, { tenantId: b.id, phone: b.phone, kind: 'admin_code' });
    expect(r).toMatchObject({ sent: false, errorCode: 131000 });
    const [row] = await rowsOf(b.id);
    expect(row).toMatchObject({ status: 'failed', errorCode: 131000, waMessageId: null });
    expect(row!.retryAt).not.toBeNull();
    // the code stays usable for the operator but is marked undelivered
    const [pc] = await orch.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.code, r.code));
    expect(pc?.sendFailedAt).not.toBeNull();
  });

  it('Retry now supersedes the scheduled retry, so the retrier never double-sends', async () => {
    const b = await approvedBusiness();
    const f = fakeSender();
    await deliverApproval(orch.db, f.sender, { tenantId: b.id, phone: b.phone, businessName: 'Kritaat' });
    const T = await dbNow(orch.db);
    await applyDeliveryStatus(orch.db, failed(f.sent[0]!.wamid, 131000), T);
    const r = await retryNow(orch.db, f.sender, { id: b.id, businessName: 'Kritaat', reviewStatus: 'approved', phone: b.phone });
    expect(r).toMatchObject({ via: 'notice', sent: true });
    expect(f.sent).toHaveLength(2);
    const live = await orch.db
      .select()
      .from(schema.onboardingMessages)
      .where(and(eq(schema.onboardingMessages.tenantId, b.id), isNull(schema.onboardingMessages.supersededAt)));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ attempt: 2, kind: 'approval_notice' });
    expect((await runDeliveryRetries(orch.db, f.sender, { now: new Date(T.getTime() + 60 * MIN) })).resent).toBe(0);
    expect(f.sent).toHaveLength(2);
  });
});
