/**
 * Identity, RBAC & TEAM ACCESS (PRD v2.0 §3) against REAL Postgres as hisab_orch.
 * Proves the team flow is safe against misuse from BOTH surfaces (owner over
 * WhatsApp, operator in the admin panel). The probes are the point:
 *   - only an OWNER (or the admin) can change the team; staff/accountant cannot,
 *   - an invitee gets ONLY the offered role and must accept from its own number,
 *   - a money message is never misread as a team command (strict grammar),
 *   - plan seat + role limits hold, including under a concurrent invite race,
 *   - expired / removed / stale-invite access is denied on the very next message,
 *   - the owner can never be invited, changed, expired or removed,
 *   - re-inviting is idempotent, never a second grant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import {
  resolveMembership,
  inviteMember,
  acceptInvite,
  changeMember,
  removeMember,
  refreshInvite,
  listTeam,
  seatsUsed,
  endedAccess,
  parseTeamCommand,
  isAcceptCommand,
  type ResolvedMembership,
} from '../src/identity/membership.js';
import { handleTeamCommand } from '../src/identity/team-chat.js';
import { handleUnknownSender, issuePairingCode } from '../src/onboarding/pairing.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

let admin: DbHandle;
let orch: DbHandle;
// Distinct e164 range (+97798000901xx) so these rows never collide with other
// fixtures that share the test database.
const n = (i: number) => `+97798000901${String(i).padStart(2, '0')}`;
const tenantIds: string[] = [];
const numbers = new Set<string>();

/** A paired, active business on `plan` (null = no subscription row). */
async function makeBusiness(ownerIdx: number, plan: 'starter' | 'pro' | 'business' | null) {
  const [t] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: `Team Traders ${ownerIdx}`, panOrVatNo: `6000${String(ownerIdx).padStart(5, '0')}` })
    .returning({ id: schema.tenants.id });
  const tenantId = t!.id;
  tenantIds.push(tenantId);
  numbers.add(n(ownerIdx));
  const code = await issuePairingCode(orch.db, tenantId);
  await handleUnknownSender(orch.db, n(ownerIdx), `START ${code}`);
  if (plan) {
    await admin.db
      .insert(schema.subscriptions)
      .values({ tenantId, planCode: plan, status: 'active', currentPeriodEnd: '2099-01-01' });
  }
  const owner = (await resolveMembership(orch.db, n(ownerIdx)))!;
  expect(owner).toMatchObject({ tenantId, role: 'owner' });
  return { tenantId, owner, chat: { via: 'chat', member: owner } as const, adminActor: { via: 'admin', tenantId } as const };
}

const track = (...idx: number[]) => idx.forEach((i) => numbers.add(n(i)));

beforeAll(async () => {
  admin = createDb(ADMIN_URL, 2);
  orch = createDb(ORCH_URL, 8);
});

afterAll(async () => {
  // clean up our rows (FK order) so the shared test DB stays collision-free.
  if (tenantIds.length) {
    await admin.db.delete(schema.auditLog).where(inArray(schema.auditLog.tenantId, tenantIds));
    await admin.db.delete(schema.memberships).where(inArray(schema.memberships.tenantId, tenantIds));
    await admin.db.delete(schema.subscriptions).where(inArray(schema.subscriptions.tenantId, tenantIds));
    await admin.db.delete(schema.pairingCodes).where(inArray(schema.pairingCodes.tenantId, tenantIds));
    await admin.db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
  }
  if (numbers.size) await admin.db.delete(schema.users).where(inArray(schema.users.whatsappE164, [...numbers]));
  await orch.close();
  await admin.close();
});

describe('parseTeamCommand (strict grammar)', () => {
  it('parses every team command form, normalising the number to +977…', () => {
    expect(parseTeamCommand('add my accountant 9800000002 as accountant')).toEqual({
      kind: 'invite',
      e164: '+9779800000002',
      role: 'accountant',
      days: null,
    });
    expect(parseTeamCommand('invite +977-9800000003 staff')).toEqual({ kind: 'invite', e164: '+9779800000003', role: 'staff', days: null });
    expect(parseTeamCommand('Add 9779800000004 as an auditor for 30 days')).toEqual({
      kind: 'invite',
      e164: '+9779800000004',
      role: 'auditor',
      days: 30,
    });
    expect(parseTeamCommand('change 9800000005 to viewer')).toEqual({ kind: 'change', e164: '+9779800000005', role: 'viewer' });
    expect(parseTeamCommand('remove 98 0000 0006')).toEqual({ kind: 'remove', e164: '+9779800000006' });
    expect(parseTeamCommand('remove 9800000006 from my team')).toEqual({ kind: 'remove', e164: '+9779800000006' });
    for (const t of ['team', 'My team?', 'show team', 'who has access']) expect(parseTeamCommand(t)).toEqual({ kind: 'list' });
  });

  it('PROBE: bookkeeping messages are NEVER read as team commands', () => {
    for (const text of [
      'add 25000000 staff salary', // 8-digit amount + "staff" — the old parser invited this
      'add 9800000002 as accountant and also make me owner',
      'add expense 12000 for staff tea',
      'remove 5000 from sales',
      'change 4500 to 4600 on the last bill',
      'what are my sales?',
      'add catering 9000',
      'team lunch 3000',
    ]) {
      expect(parseTeamCommand(text)).toBeNull();
    }
  });

  it('PROBE: owner is never a grantable role; bad numbers/days are flagged, not guessed', () => {
    expect(parseTeamCommand('add 9800000004 as owner')).toBeNull();
    expect(parseTeamCommand('add 12345678 as staff')).toEqual({ kind: 'malformed', hint: 'number' }); // landline-ish
    expect(parseTeamCommand('add 9800000004 as auditor for 0 days')).toEqual({ kind: 'malformed', hint: 'days' });
    expect(parseTeamCommand('add 9800000004 as auditor for 999 days')).toEqual({ kind: 'malformed', hint: 'days' });
    expect(parseTeamCommand('x'.repeat(500))).toBeNull();
  });

  it('recognises acceptance', () => {
    expect(isAcceptCommand('JOIN')).toBe(true);
    expect(isAcceptCommand('yes please')).toBe(true);
    expect(isAcceptCommand('show my sales')).toBe(false);
  });
});

describe('resolveMembership', () => {
  it('returns null for an unknown number (no membership = no access)', async () => {
    expect(await resolveMembership(orch.db, '+9779999999999')).toBeNull();
  });

  it('PROBE: a user active on TWO tenants resolves DETERMINISTICALLY (oldest membership), never arbitrarily', async () => {
    const a = await makeBusiness(1, 'pro');
    const [t2] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Second Biz', panOrVatNo: '600009002', status: 'active' })
      .returning({ id: schema.tenants.id });
    tenantIds.push(t2!.id);
    await admin.db.insert(schema.memberships).values({
      userId: a.owner.userId,
      tenantId: t2!.id,
      role: 'viewer',
      status: 'active',
      createdAt: new Date(Date.now() + 60_000), // strictly newer
    });
    for (let i = 0; i < 3; i += 1) expect((await resolveMembership(orch.db, n(1)))!.tenantId).toBe(a.tenantId);
    await admin.db.delete(schema.memberships).where(eq(schema.memberships.tenantId, t2!.id));
  });
});

describe('invite + accept (owner over chat)', () => {
  let b: Awaited<ReturnType<typeof makeBusiness>>;
  beforeAll(async () => {
    b = await makeBusiness(10, 'pro'); // pro = owner + 2
    track(11, 12, 13);
  });

  it('REGRESSION PROBE: an invite typed as a LOCAL number is accepted by JOIN from the +977 sender', async () => {
    // before 0023 the invite stored "9800090111" while WhatsApp delivers "+9779800090111", so JOIN never matched
    const res = await inviteMember(orch.db, b.chat, '9800090111', 'accountant');
    expect(res).toMatchObject({ kind: 'invited', role: 'accountant', inviteE164: n(11) });
    expect(await resolveMembership(orch.db, n(11))).toBeNull(); // no access until accepted
    expect(await acceptInvite(orch.db, n(11))).toMatchObject({ kind: 'accepted', tenantId: b.tenantId, role: 'accountant' });
    expect(await resolveMembership(orch.db, n(11))).toMatchObject({ role: 'accountant' });
  });

  it('PROBE: a non-owner (accountant) CANNOT invite, change, remove or list', async () => {
    const accountant = (await resolveMembership(orch.db, n(11)))!;
    const actor = { via: 'chat', member: accountant } as const;
    expect(await inviteMember(orch.db, actor, n(12), 'staff')).toEqual({ kind: 'not_owner' });
    expect(await changeMember(orch.db, actor, n(11), { role: 'viewer' })).toEqual({ kind: 'not_owner' });
    expect(await removeMember(orch.db, actor, n(10))).toEqual({ kind: 'not_owner' });
    const reply = await handleTeamCommand({ db: orch.db, sendInvite: async () => undefined }, accountant, { kind: 'list' });
    expect(reply).toMatch(/Only the business owner/);
    expect(await resolveMembership(orch.db, n(12))).toBeNull(); // nothing granted
  });

  it('PROBE: an uninvited number accepting gets nothing; another number cannot accept your invite', async () => {
    expect(await acceptInvite(orch.db, '+9779777777777')).toEqual({ kind: 'no_invite' });
    expect(await inviteMember(orch.db, b.chat, n(12), 'auditor', { days: 30 })).toMatchObject({ kind: 'invited', role: 'auditor' });
    expect(await acceptInvite(orch.db, n(13))).toEqual({ kind: 'no_invite' }); // n(13) was never invited
    expect(await resolveMembership(orch.db, n(12))).toBeNull();
  });

  it('PROBE: a double JOIN (concurrent) activates exactly once', async () => {
    const outs = await Promise.all([acceptInvite(orch.db, n(12)), acceptInvite(orch.db, n(12)), acceptInvite(orch.db, n(12))]);
    expect(outs.filter((o) => o.kind === 'accepted')).toHaveLength(1);
    const joined = await admin.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, b.tenantId), eq(schema.auditLog.action, 'member_joined')));
    expect(joined).toHaveLength(2); // accountant + auditor, once each
    const m = (await resolveMembership(orch.db, n(12)))!;
    expect(m.role).toBe('auditor');
  });

  it('time-limited access carries its end date (about 30 days out)', async () => {
    const [row] = await listTeam(orch.db, b.tenantId).then((r) => r.filter((x) => x.e164 === n(12)));
    const days = (row!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('PROBE: re-inviting an active member is idempotent, never a second grant', async () => {
    expect((await inviteMember(orch.db, b.chat, n(11), 'accountant')).kind).toBe('already_member');
    const rows = await admin.db.select().from(schema.memberships).where(eq(schema.memberships.tenantId, b.tenantId));
    expect(rows.filter((r) => r.status !== 'revoked')).toHaveLength(3); // owner + accountant + auditor
  });

  it('PROBE: the plan is full (pro = 3 people) — the next invite is refused', async () => {
    expect(await seatsUsed(orch.db, b.tenantId)).toBe(3);
    expect(await inviteMember(orch.db, b.chat, n(13), 'viewer')).toEqual({ kind: 'seat_limit', plan: 'pro', seats: 3, used: 3 });
  });

  it('PROBE: the owner can never be invited, changed or removed', async () => {
    expect(await inviteMember(orch.db, b.chat, n(10), 'viewer')).toMatchObject({ kind: 'already_member', role: 'owner' });
    expect(await inviteMember(orch.db, b.chat, n(13), 'owner')).toEqual({ kind: 'bad_role' });
    expect(await changeMember(orch.db, b.adminActor, n(10), { role: 'viewer' })).toEqual({ kind: 'is_owner' });
    expect(await removeMember(orch.db, b.adminActor, n(10))).toEqual({ kind: 'is_owner' });
    expect((await resolveMembership(orch.db, n(10)))!.role).toBe('owner');
  });

  it('PROBE: the database itself refuses an expiring owner', async () => {
    const err = await admin.db
      .execute(sql`update memberships set expires_at = now() + interval '1 day' where tenant_id = ${b.tenantId} and role = 'owner'`)
      .then(() => null, (e: unknown) => e as { cause?: { constraint_name?: string } });
    expect(err?.cause?.constraint_name).toBe('memberships_owner_never_expires');
  });

  it('change a role, then remove: access is denied on the very next message', async () => {
    expect(await changeMember(orch.db, b.chat, n(11), { role: 'viewer' })).toMatchObject({ kind: 'changed', role: 'viewer' });
    expect((await resolveMembership(orch.db, n(11)))!.role).toBe('viewer');
    expect(await removeMember(orch.db, b.chat, '9800090111')).toMatchObject({ kind: 'removed', role: 'viewer' });
    expect(await resolveMembership(orch.db, n(11))).toBeNull();
    expect(await endedAccess(orch.db, n(11))).toEqual({ businessName: 'Team Traders 10', why: 'removed' });
    expect(await seatsUsed(orch.db, b.tenantId)).toBe(2); // seat freed
    expect(await removeMember(orch.db, b.chat, n(11))).toEqual({ kind: 'not_found' }); // removing twice is a no-op
  });

  it('a removed person can be invited again (history row kept)', async () => {
    expect(await inviteMember(orch.db, b.chat, n(11), 'staff')).toMatchObject({ kind: 'invited', role: 'staff' });
    expect(await acceptInvite(orch.db, n(11))).toMatchObject({ kind: 'accepted', role: 'staff' });
    const all = await listTeam(orch.db, b.tenantId, { history: true });
    expect(all.filter((r) => r.e164 === n(11)).map((r) => r.status).sort()).toEqual(['active', 'removed']);
  });

  it('PROBE: expired access is denied immediately, frees the seat, and cannot be "changed" back to life', async () => {
    await admin.db.execute(
      sql`update memberships set expires_at = now() - interval '1 minute' where tenant_id = ${b.tenantId} and user_id = (select id from users where whatsapp_e164 = ${n(12)})`,
    );
    expect(await resolveMembership(orch.db, n(12))).toBeNull();
    expect(await endedAccess(orch.db, n(12))).toEqual({ businessName: 'Team Traders 10', why: 'expired' });
    expect(await seatsUsed(orch.db, b.tenantId)).toBe(2);
    expect(await changeMember(orch.db, b.adminActor, n(12), { days: 30 })).toEqual({ kind: 'not_found' });
    // a fresh invite revives it properly (seat-checked, must JOIN again)
    expect(await inviteMember(orch.db, b.chat, n(12), 'auditor')).toMatchObject({ kind: 'invited', expiresAt: null });
    expect(await resolveMembership(orch.db, n(12))).toBeNull();
    expect(await acceptInvite(orch.db, n(12))).toMatchObject({ kind: 'accepted', expiresAt: null });
  });
});

describe('plan limits', () => {
  it('starter is the owner alone; an accountant points at Pro; no subscription = starter rules', async () => {
    const s = await makeBusiness(20, 'starter');
    const none = await makeBusiness(21, null);
    track(22);
    expect(await inviteMember(orch.db, s.chat, n(22), 'accountant')).toEqual({
      kind: 'role_not_in_plan',
      plan: 'starter',
      role: 'accountant',
      minPlan: 'pro',
    });
    expect(await inviteMember(orch.db, s.chat, n(22), 'auditor')).toMatchObject({ kind: 'seat_limit', plan: 'starter', seats: 1 });
    expect(await inviteMember(orch.db, none.chat, n(22), 'viewer')).toMatchObject({ kind: 'seat_limit', plan: 'starter' });
  });

  it('admin "testing/support" override bypasses the plan — and says so in the audit log', async () => {
    const s = await makeBusiness(23, 'starter');
    track(24);
    const res = await inviteMember(orch.db, { via: 'admin', tenantId: s.tenantId, overridePlan: true }, n(24), 'accountant', { days: 7 });
    expect(res).toMatchObject({ kind: 'invited', overridden: true });
    const [audit] = await admin.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, s.tenantId), eq(schema.auditLog.action, 'member_invited')));
    expect(audit!.detail).toMatchObject({ by: 'admin', plan_override: 'starter', role: 'accountant', days: 7 });
    // without the override the admin is bound by the same rules as the owner
    track(25);
    expect((await inviteMember(orch.db, { via: 'admin', tenantId: s.tenantId }, n(25), 'viewer')).kind).toBe('seat_limit');
  });

  it('PROBE: 6 concurrent invites for the last 2 seats — exactly 2 win (no over-allocation race)', async () => {
    const p = await makeBusiness(30, 'pro');
    track(31, 32, 33, 34, 35, 36);
    const results = await Promise.all([31, 32, 33, 34, 35, 36].map((i) => inviteMember(orch.db, p.chat, n(i), 'viewer')));
    expect(results.filter((r) => r.kind === 'invited')).toHaveLength(2);
    expect(results.filter((r) => r.kind === 'seat_limit')).toHaveLength(4);
    expect(await seatsUsed(orch.db, p.tenantId)).toBe(3);
  });

  it('PROBE: a stale invite (older than 7 days) cannot be accepted, frees its seat, and resend re-checks the plan', async () => {
    const p = await makeBusiness(40, 'pro');
    track(41, 42, 43);
    await inviteMember(orch.db, p.chat, n(41), 'viewer');
    await inviteMember(orch.db, p.chat, n(42), 'viewer');
    await admin.db.execute(
      sql`update memberships set updated_at = now() - interval '8 days' where tenant_id = ${p.tenantId} and status = 'invited' and user_id = (select id from users where whatsapp_e164 = ${n(41)})`,
    );
    expect(await acceptInvite(orch.db, n(41))).toEqual({ kind: 'no_invite' });
    expect(await seatsUsed(orch.db, p.tenantId)).toBe(2);
    // the freed seat is taken by someone else…
    expect((await inviteMember(orch.db, p.chat, n(43), 'viewer')).kind).toBe('invited');
    // …so the stale invite can no longer be re-opened without an override
    expect(await refreshInvite(orch.db, { via: 'admin', tenantId: p.tenantId }, n(41))).toEqual({ kind: 'seat_limit' });
    expect((await refreshInvite(orch.db, { via: 'admin', tenantId: p.tenantId, overridePlan: true }, n(41))).kind).toBe('refreshed');
  });

  it('PROBE: changing a member to a role the plan lacks is refused (staff → accountant on starter)', async () => {
    const s = await makeBusiness(50, 'starter');
    track(51);
    await inviteMember(orch.db, { via: 'admin', tenantId: s.tenantId, overridePlan: true }, n(51), 'staff');
    expect(await changeMember(orch.db, s.chat, n(51), { role: 'accountant' })).toMatchObject({ kind: 'role_not_in_plan', minPlan: 'pro' });
  });
});

describe('cross-business + lifecycle probes', () => {
  it('PROBE: a number active on ANOTHER business cannot be invited (it would land on the wrong books)', async () => {
    const a = await makeBusiness(60, 'business');
    await makeBusiness(61, 'business'); // n(61) owns its own business
    expect(await inviteMember(orch.db, a.chat, n(61), 'auditor')).toEqual({ kind: 'busy_elsewhere' });
  });

  it('PROBE: a suspended business cannot add anyone, and its members lose access', async () => {
    const a = await makeBusiness(62, 'business');
    track(63, 64);
    await inviteMember(orch.db, a.chat, n(63), 'accountant');
    await acceptInvite(orch.db, n(63));
    await admin.db.update(schema.tenants).set({ status: 'suspended' }).where(eq(schema.tenants.id, a.tenantId));
    expect(await inviteMember(orch.db, a.adminActor, n(64), 'viewer')).toEqual({ kind: 'tenant_inactive' });
    expect(await resolveMembership(orch.db, n(63))).toBeNull();
    await admin.db.update(schema.tenants).set({ status: 'active' }).where(eq(schema.tenants.id, a.tenantId));
  });

  it('bad inputs are rejected before touching the database', async () => {
    const a = await makeBusiness(65, 'business');
    expect(await inviteMember(orch.db, a.chat, 'not a number', 'viewer')).toEqual({ kind: 'bad_number' });
    expect(await inviteMember(orch.db, a.chat, n(66), 'viewer', { days: 0 })).toEqual({ kind: 'bad_days' });
    expect(await inviteMember(orch.db, a.chat, n(66), 'viewer', { days: 1.5 })).toEqual({ kind: 'bad_days' });
    expect(await inviteMember(orch.db, a.chat, n(66), 'superadmin' as never)).toEqual({ kind: 'bad_role' });
  });

  it('chat replies: invite → team list shows the person and their end date', async () => {
    const a = await makeBusiness(70, 'business');
    track(71);
    const sent: string[] = [];
    const deps = { db: orch.db, sendInvite: async (to: string) => void sent.push(to) };
    const invited = await handleTeamCommand(deps, a.owner, parseTeamCommand('add 9800090171 as auditor for 30 days')!);
    expect(invited).toMatch(/Invite sent to \+9779800090171 as auditor/);
    expect(invited).toMatch(/read-only/);
    expect(sent).toEqual([n(71)]);
    const list = await handleTeamCommand(deps, a.owner, { kind: 'list' });
    expect(list).toMatch(/\+9779800090171: auditor \(invite not accepted yet\), until \d{4}-\d{2}-\d{2}/);
    const removed = await handleTeamCommand(deps, a.owner, parseTeamCommand('remove 9800090171')!);
    expect(removed).toMatch(/no longer has access/);
  });
});

// the owner pairing path still grants exactly one owner membership
describe('pairing creates the owner', () => {
  it('owner membership is system-granted, active, never expiring', async () => {
    const a = await makeBusiness(80, 'pro');
    const [row] = await admin.db.select().from(schema.memberships).where(eq(schema.memberships.tenantId, a.tenantId));
    expect(row).toMatchObject({ role: 'owner', status: 'active', expiresAt: null, grantedVia: 'system' });
    const owner: ResolvedMembership = a.owner;
    expect(owner.role).toBe('owner');
  });
});
