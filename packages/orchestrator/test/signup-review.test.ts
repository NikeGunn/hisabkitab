/**
 * Pilot applications reviewed by the operator (signup.require_approval = on),
 * against REAL Postgres as hisab_orch. Invariant: before Approve, NOTHING is sent
 * to the applicant's number and the number can never pair. PROBES: resubmits,
 * racing submissions, an awaiting applicant trying codes, another number, racing
 * messages after approval, declined applicants, the daily cap, bots, and the
 * operator switching review off while applications wait.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import { handleSignup, type SignupDeps } from '../src/signup/signup.js';
import { handleUnknownSender, underReviewReply } from '../src/onboarding/pairing.js';
import { ORCH_URL } from './urls.js';

let orch: DbHandle;
beforeAll(() => {
  orch = createDb(ORCH_URL, 6);
});
afterAll(async () => {
  await orch.close();
});

let seq = 0;
const freshPhone = () => `97${String(10_000_000 + (Date.now() % 1_000_000) * 10 + (seq += 1)).slice(-8)}`;
const e164 = (local: string) => `+977${local}`;
const ALERT = '+9779800000009';

type Sent = { to: string; template: string; code?: string; params?: string[] };
function deps(over: Partial<SignupDeps['settings']> = {}, sent: Sent[] = []) {
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
      alertE164: () => ALERT,
      requireApproval: () => true,
      ...over,
    },
  };
  return { d, sent };
}

const form = (phone: string, extra: Record<string, unknown> = {}) => ({
  business_name: 'Karki Hardware',
  owner_name: 'Hari Karki',
  whatsapp: phone,
  pan_vat: '601234999',
  consent: true,
  ...extra,
});

const applicationOf = async (phone: string) =>
  orch.db.select().from(schema.tenants).where(eq(schema.tenants.applicantE164, e164(phone)));
const codesFor = async (tenantId: string) =>
  orch.db.select().from(schema.pairingCodes).where(eq(schema.pairingCodes.tenantId, tenantId));
const approve = (id: string) =>
  orch.db.update(schema.tenants).set({ reviewStatus: 'approved', reviewedAt: sql`now()` }).where(eq(schema.tenants.id, id));

describe('application (review first)', () => {
  it('records an application, sends NOTHING to the applicant, alerts only the operator', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    const r = await handleSignup(d, form(phone));
    expect(r).toMatchObject({ status: 'under_review', resubmitted: false, wa_link: 'https://wa.me/9779745861381?text=START%20' });
    expect(d.sendAuthCode).not.toHaveBeenCalled();
    expect(sent.filter((s) => s.to === e164(phone))).toHaveLength(0);
    expect(sent).toEqual([{ to: ALERT, template: 'admin_account_update', params: ['Karki Hardware'] }]);

    const [t] = await applicationOf(phone);
    expect(t).toMatchObject({ status: 'pending', reviewStatus: 'awaiting', whatsappE164: null, signupSource: 'web' });
    expect(await codesFor(t!.id)).toHaveLength(0); // no code exists at all
    const [ev] = await orch.db
      .select()
      .from(schema.adminEvents)
      .where(and(eq(schema.adminEvents.action, 'signup.applied'), sql`${schema.adminEvents.detail}->>'tenant_id' = ${t!.id}`));
    expect(ev).toBeDefined();
  });

  it('resubmitting refreshes the same application, no second alert', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const r = await handleSignup(d, form(phone, { business_name: 'Karki Hardware & Paints' }));
    expect(r).toMatchObject({ status: 'under_review', resubmitted: true });
    const apps = await applicationOf(phone);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.businessName).toBe('Karki Hardware & Paints');
    expect(sent.filter((s) => s.template === 'admin_account_update')).toHaveLength(1);
  });

  it('PROBE: 8 racing submissions for one number create exactly one application', async () => {
    const phone = freshPhone();
    const { d } = deps();
    const results = await Promise.all(Array.from({ length: 8 }, () => handleSignup(d, form(phone))));
    expect(results.every((r) => r.status === 'under_review')).toBe(true);
    expect(results.filter((r) => r.status === 'under_review' && !r.resubmitted)).toHaveLength(1);
    expect(await applicationOf(phone)).toHaveLength(1);
  });

  it('PROBE: an awaiting applicant can NEVER pair: hi, START <guess>, bare code all answer "under review"', async () => {
    const phone = freshPhone();
    const { d } = deps();
    await handleSignup(d, form(phone));
    for (const text of ['hi', 'START 123456', '123456', undefined]) {
      expect(await handleUnknownSender(orch.db, e164(phone), text, { trialPlan: 'pro' })).toEqual({
        kind: 'under_review',
        businessName: 'Karki Hardware',
      });
    }
    const [t] = await applicationOf(phone);
    expect(t).toMatchObject({ status: 'pending', whatsappE164: null });
    const members = await orch.db.select().from(schema.memberships).where(eq(schema.memberships.tenantId, t!.id));
    expect(members).toHaveLength(0);
    expect(underReviewReply('Karki Hardware')).toMatch(/review/);
  });

  it('approved: the first message FROM the applicant pairs it as owner and starts the trial', async () => {
    const phone = freshPhone();
    const { d } = deps();
    await handleSignup(d, form(phone));
    const [t] = await applicationOf(phone);
    await approve(t!.id);
    const out = await handleUnknownSender(orch.db, e164(phone), 'hello', { trialPlan: 'pro' });
    expect(out).toEqual({ kind: 'paired', tenantId: t!.id, businessName: 'Karki Hardware' });
    const [after] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, t!.id));
    expect(after).toMatchObject({ status: 'active', whatsappE164: e164(phone) });
    const [sub] = await orch.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, t!.id));
    expect(sub).toMatchObject({ planCode: 'pro', status: 'trial' });
    const [m] = await orch.db.select().from(schema.memberships).where(eq(schema.memberships.tenantId, t!.id));
    expect(m).toMatchObject({ role: 'owner', status: 'active' });
  });

  it('PROBE: approval never lets ANOTHER number in', async () => {
    const phone = freshPhone();
    const { d } = deps();
    await handleSignup(d, form(phone));
    const [t] = await applicationOf(phone);
    await approve(t!.id);
    const attacker = e164(freshPhone());
    expect((await handleUnknownSender(orch.db, attacker, 'hi')).kind).toBe('no_code');
    expect((await handleUnknownSender(orch.db, attacker, `START 000000`)).kind).toBe('invalid_code');
    const [after] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, t!.id));
    expect(after).toMatchObject({ status: 'pending', whatsappE164: null });
  });

  it('PROBE: 6 racing first messages after approval pair exactly once', async () => {
    const phone = freshPhone();
    const { d } = deps();
    await handleSignup(d, form(phone));
    const [t] = await applicationOf(phone);
    await approve(t!.id);
    const outs = await Promise.all(
      Array.from({ length: 6 }, () => handleUnknownSender(orch.db, e164(phone), 'hi', { trialPlan: 'pro' })),
    );
    expect(outs.filter((o) => o.kind === 'paired')).toHaveLength(1);
    const pairings = await orch.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, t!.id), eq(schema.auditLog.action, 'whatsapp_paired')));
    expect(pairings).toHaveLength(1);
    expect(await orch.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, t!.id))).toHaveLength(1);
  });

  it('PROBE: a declined applicant is not paired and not told "under review"; re-applying re-queues it', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const [t] = await applicationOf(phone);
    await orch.db.update(schema.tenants).set({ reviewStatus: 'declined' }).where(eq(schema.tenants.id, t!.id));
    expect((await handleUnknownSender(orch.db, e164(phone), 'hi')).kind).toBe('no_code');
    expect((await handleUnknownSender(orch.db, e164(phone), 'START 123456')).kind).toBe('invalid_code');

    const again = await handleSignup(d, form(phone));
    expect(again).toMatchObject({ status: 'under_review', resubmitted: false });
    const apps = await applicationOf(phone);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.reviewStatus).toBe('awaiting');
    expect(sent.filter((s) => s.template === 'admin_account_update')).toHaveLength(2); // operator sees it again
    expect(d.sendAuthCode).not.toHaveBeenCalled();
  });

  it('approved applicant who missed our message: resubmitting sends a code bound to the number', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    await handleSignup(d, form(phone));
    const [t] = await applicationOf(phone);
    await approve(t!.id);
    const r = await handleSignup(d, form(phone, { business_name: 'Renamed After Review' }));
    expect(r.status).toBe('code_sent');
    const code = sent.find((s) => s.template === 'pairing_code');
    expect(code?.to).toBe(e164(phone));
    const [after] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, t!.id));
    expect(after!.businessName).toBe('Karki Hardware'); // reviewed details are kept
    expect((await handleUnknownSender(orch.db, e164(phone), `START ${code!.code}`, { trialPlan: 'pro' })).kind).toBe('paired');
  });

  it('PROBE: the daily application cap answers busy and stores nothing', async () => {
    const phone = freshPhone();
    const { d, sent } = deps({ dailyCap: () => 0 });
    expect(await handleSignup(d, form(phone))).toEqual({ status: 'busy' });
    expect(await applicationOf(phone)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('PROBE: a bot (honeypot) gets the same answer as a person but nothing is stored or sent', async () => {
    const phone = freshPhone();
    const { d, sent } = deps();
    expect(await handleSignup(d, form(phone, { website: 'http://spam.example' }))).toEqual({
      status: 'under_review',
      resubmitted: false,
    });
    expect(await applicationOf(phone)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('PROBE: closed signup and an already-registered number never create an application', async () => {
    const phone = freshPhone();
    const closed = deps({ enabled: () => false });
    expect(await handleSignup(closed.d, form(phone))).toEqual({ status: 'closed' });
    expect(await applicationOf(phone)).toHaveLength(0);

    const { d } = deps();
    await handleSignup(d, form(phone));
    const [t] = await applicationOf(phone);
    await approve(t!.id);
    await handleUnknownSender(orch.db, e164(phone), 'hi', { trialPlan: 'pro' });
    const r = await handleSignup(d, form(phone, { business_name: 'Second Shop' }));
    expect(r.status).toBe('already_registered');
    expect(await applicationOf(phone)).toHaveLength(1);
  });

  it('operator switches review OFF while an application waits: resubmit sends a code to the SAME business', async () => {
    const phone = freshPhone();
    const on = deps();
    await handleSignup(on.d, form(phone));
    const off = deps({ requireApproval: () => false });
    const r = await handleSignup(off.d, form(phone));
    expect(r.status).toBe('code_sent');
    const apps = await applicationOf(phone);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.reviewStatus).toBe('approved');
    expect(off.sent.find((s) => s.template === 'pairing_code')?.to).toBe(e164(phone));
  });
});
