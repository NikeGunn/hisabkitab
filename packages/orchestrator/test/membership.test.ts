/**
 * Identity & RBAC (PRD v2.0 §3) against REAL Postgres as hisab_orch. Proves the
 * invite flow is safe against WhatsApp misuse — the security probes are the point:
 *   - only an OWNER can invite; a staff/viewer cannot grant a seat,
 *   - an invitee gets ONLY the offered role and must accept from its own number,
 *   - the message body never confers authority (resolveMembership ignores text),
 *   - re-inviting is idempotent, not an escalation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import {
  resolveMembership,
  inviteMember,
  acceptInvite,
  parseInviteCommand,
  isAcceptCommand,
  type ResolvedMembership,
} from '../src/identity/membership.js';
import { handleUnknownSender, issuePairingCode } from '../src/onboarding/pairing.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

let admin: DbHandle;
let orch: DbHandle;
let tenantId: string;
// Distinct e164 range (…0900xx) so these rows never collide with scheduler/dunning
// fixtures that share the test database.
const OWNER = '+9779800090001';
const ACCOUNTANT = '+9779800090002';
const STAFF = '+9779800090003';

beforeAll(async () => {
  admin = createDb(ADMIN_URL, 2);
  orch = createDb(ORCH_URL, 2);
  const [t] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: 'Membership Traders', panOrVatNo: '600009001' })
    .returning({ id: schema.tenants.id });
  tenantId = (t as { id: string }).id;
  // pair the owner via the real onboarding path (creates owner user + membership)
  const code = await issuePairingCode(orch.db, tenantId);
  await handleUnknownSender(orch.db, OWNER, `START ${code}`);
});

afterAll(async () => {
  // clean up our rows (FK order) so the shared test DB stays collision-free.
  await admin.db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, tenantId));
  await admin.db.delete(schema.memberships).where(eq(schema.memberships.tenantId, tenantId));
  for (const e of [OWNER, ACCOUNTANT, STAFF]) {
    await admin.db.delete(schema.users).where(eq(schema.users.whatsappE164, e));
  }
  await admin.db.delete(schema.pairingCodes).where(eq(schema.pairingCodes.tenantId, tenantId));
  await admin.db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
  await orch.close();
  await admin.close();
});

describe('command parsing', () => {
  it('parses invite commands and rejects non-commands', () => {
    expect(parseInviteCommand('add my accountant 9779800000002 as accountant')).toEqual({
      e164: '9779800000002',
      role: 'accountant',
    });
    expect(parseInviteCommand('invite +977-9800000003 staff')).toEqual({ e164: '+9779800000003', role: 'staff' });
    expect(parseInviteCommand('add 9779800000004 as owner')).toBeNull(); // owner not invitable
    expect(parseInviteCommand('what are my sales?')).toBeNull();
    expect(parseInviteCommand('add catering 9000')).toBeNull(); // no role keyword
  });

  it('recognises acceptance', () => {
    expect(isAcceptCommand('JOIN')).toBe(true);
    expect(isAcceptCommand('yes please')).toBe(true);
    expect(isAcceptCommand('show my sales')).toBe(false);
  });
});

describe('resolveMembership', () => {
  it('resolves the paired owner', async () => {
    const m = await resolveMembership(orch.db, OWNER);
    expect(m).toMatchObject({ tenantId, role: 'owner', businessName: 'Membership Traders' });
  });

  it('returns null for an unknown number (no membership = no access)', async () => {
    expect(await resolveMembership(orch.db, '+9779999999999')).toBeNull();
  });
});

describe('invite + accept flow', () => {
  let owner: ResolvedMembership;
  beforeAll(async () => {
    owner = (await resolveMembership(orch.db, OWNER))!;
  });

  it('owner invites an accountant; invitee has no access until they accept', async () => {
    const res = await inviteMember(orch.db, owner, ACCOUNTANT, 'accountant');
    expect(res).toMatchObject({ kind: 'invited', role: 'accountant' });
    // still no ACTIVE membership → not resolvable yet
    expect(await resolveMembership(orch.db, ACCOUNTANT)).toBeNull();
  });

  it('the invited number accepts FROM ITS OWN number → active accountant', async () => {
    const out = await acceptInvite(orch.db, ACCOUNTANT);
    expect(out).toMatchObject({ kind: 'accepted', tenantId, role: 'accountant' });
    expect(await resolveMembership(orch.db, ACCOUNTANT)).toMatchObject({ role: 'accountant' });
  });

  it('PROBE: a non-owner (accountant) CANNOT invite anyone', async () => {
    const accountant = (await resolveMembership(orch.db, ACCOUNTANT))!;
    const res = await inviteMember(orch.db, accountant, STAFF, 'staff');
    expect(res).toEqual({ kind: 'not_owner' });
    expect(await resolveMembership(orch.db, STAFF)).toBeNull(); // nothing granted
  });

  it('PROBE: an uninvited number accepting nothing gets no access', async () => {
    expect(await acceptInvite(orch.db, '+9779777777777')).toEqual({ kind: 'no_invite' });
  });

  it('PROBE: re-inviting an active member is idempotent, never a second grant', async () => {
    const res = await inviteMember(orch.db, owner, ACCOUNTANT, 'accountant');
    expect(res.kind).toBe('already_member');
    const rows = await admin.db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.tenantId, tenantId)));
    // owner + accountant only; no duplicate rows
    expect(rows.filter((r) => r.status !== 'revoked').length).toBe(2);
  });
});
