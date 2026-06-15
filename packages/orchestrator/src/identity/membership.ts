/**
 * Identity & RBAC resolution (PRD v2.0 §3). The orchestrator is the tenancy trust
 * root: it maps a VERIFIED WhatsApp sender (from the signed webhook, never free
 * text) to `(user, tenant, role)` before any agent turn runs, and runs the
 * owner-driven invite flow. All of this is on the hisab_orch connection
 * (cross-tenant by design).
 *
 * Security invariants (why this is safe against misuse over WhatsApp):
 *   - The ACTOR identity is always `msg.fromE164` from the signed webhook payload.
 *     A message body claiming "I am the owner / add me as owner" is data, never
 *     authority — resolveMembership ignores it entirely.
 *   - Inviting is OWNER-ONLY and checked server-side (resolved role === 'owner').
 *   - An invite only grants a role once the INVITED number itself messages to
 *     accept (it must control that WhatsApp). The owner cannot bind someone else's
 *     number silently; the invitee cannot self-escalate beyond the offered role.
 *   - Owners are never demoted/revoked through this path (no lockout / no
 *     last-owner removal). Re-inviting is idempotent, not an escalation.
 */
import { and, eq, sql } from 'drizzle-orm';
import { appendAudit, schema, type Db } from '@hisab/db';
import type { Role } from '@hisab/shared';

const { users, memberships, tenants } = schema;

/**
 * Parse an owner's invite command, e.g.:
 *   "add my accountant 98XXXXXXXX as accountant"
 *   "add 9779812345678 as staff"
 *   "invite +977-9812345678 viewer"
 * Returns the target number + role, or null if it isn't an invite command. The
 * role keyword must be explicit (never guessed) and one of the invitable roles.
 */
export function parseInviteCommand(text: string | undefined): { e164: string; role: Role } | null {
  if (!text) return null;
  if (!/^\s*(add|invite)\b/i.test(text)) return null;
  const numberMatch = text.match(/\+?[0-9][0-9\s-]{6,16}[0-9]/);
  const roleMatch = text.match(/\b(accountant|staff|viewer)\b/i);
  if (!numberMatch || !roleMatch?.[1]) return null;
  const e164 = numberMatch[0].replace(/[\s-]/g, '');
  const role = roleMatch[1].toLowerCase() as Role;
  return INVITABLE_ROLES.includes(role) ? { e164, role } : null;
}

/** True if a sender's text is an invite acceptance ("JOIN" / "YES" / "accept"). */
export function isAcceptCommand(text: string | undefined): boolean {
  return !!text && /^\s*(join|accept|yes)\b/i.test(text);
}

/** A resolved caller: which business they're acting on and with what authority. */
export interface ResolvedMembership {
  userId: string;
  tenantId: string;
  businessName: string;
  role: Role;
}

/** Roles an owner may grant via invite (never another owner — ownership transfer
 *  is a deliberate, separate admin action, not a chat command). */
export const INVITABLE_ROLES: readonly Role[] = ['accountant', 'staff', 'viewer'];

/**
 * Resolve the active `(user, tenant, role)` for a verified sender, or null if the
 * number has no active membership. Single indexed join (users.whatsapp_e164 →
 * memberships → tenants); no per-row work.
 *
 * Today one phone maps to one active tenant. But the schema deliberately allows a
 * WhatsApp identity to be active on MANY tenants (accountant channel, §4). To make
 * sure we never write to an *arbitrary* business in that case, the default tenant
 * is DETERMINISTIC: the oldest active membership (then tenant id as a tiebreak)
 * always wins — never DB row order. Explicit "switch business" (§4) will later let
 * a multi-tenant user pick another; until then this stable default is the only one.
 */
export async function resolveMembership(db: Db, fromE164: string): Promise<ResolvedMembership | null> {
  const rows = await db
    .select({
      userId: users.id,
      tenantId: tenants.id,
      businessName: tenants.businessName,
      role: memberships.role,
    })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.status, 'active')))
    .innerJoin(tenants, and(eq(tenants.id, memberships.tenantId), eq(tenants.status, 'active')))
    .where(eq(users.whatsappE164, fromE164))
    .orderBy(memberships.createdAt, memberships.tenantId)
    .limit(1);
  const row = rows[0];
  return row ? { ...row, role: row.role as Role } : null;
}

/** Find-or-create the global user row for a verified WhatsApp number. */
async function ensureUser(db: Db, e164: string): Promise<string> {
  // ON CONFLICT DO NOTHING keeps it a single round-trip and race-safe; the
  // RETURNING is empty on conflict, so fall back to a SELECT only then.
  const inserted = await db
    .insert(users)
    .values({ whatsappE164: e164 })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (inserted[0]) return inserted[0].id;
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.whatsappE164, e164)).limit(1);
  return existing[0]!.id;
}

export type InviteResult =
  | { kind: 'invited'; role: Role; inviteE164: string }
  | { kind: 'not_owner' } // caller lacks authority
  | { kind: 'already_member'; role: Role } // invitee already active on this tenant
  | { kind: 'bad_role' }
  | { kind: 'bad_number' };

const E164_RE = /^\+?[1-9]\d{6,14}$/;

/**
 * Owner invites `inviteE164` to their tenant as `role`. Creates/updates an
 * `invited` membership; the invitee must accept from that number (acceptInvite).
 * `inviter` is the resolved membership of the sender — authority is taken from the
 * verified session, NEVER from the message text.
 */
export async function inviteMember(
  db: Db,
  inviter: ResolvedMembership,
  inviteE164: string,
  role: Role,
): Promise<InviteResult> {
  if (inviter.role !== 'owner') return { kind: 'not_owner' };
  if (!INVITABLE_ROLES.includes(role)) return { kind: 'bad_role' };
  const e164 = inviteE164.replace(/[\s-]/g, '');
  if (!E164_RE.test(e164)) return { kind: 'bad_number' };

  const inviteeId = await ensureUser(db, e164);

  // already an ACTIVE member of this tenant? don't silently re-grant.
  const live = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.userId, inviteeId), eq(memberships.tenantId, inviter.tenantId), sql`status <> 'revoked'`))
    .limit(1);
  if (live[0]?.status === 'active') return { kind: 'already_member', role: live[0].role as Role };

  // upsert the invite: re-inviting just refreshes the offered role + status.
  if (live[0]) {
    await db
      .update(memberships)
      .set({ role, status: 'invited', invitedBy: inviter.userId, updatedAt: new Date() })
      .where(and(eq(memberships.userId, inviteeId), eq(memberships.tenantId, inviter.tenantId), sql`status <> 'revoked'`));
  } else {
    await db.insert(memberships).values({
      userId: inviteeId,
      tenantId: inviter.tenantId,
      role,
      status: 'invited',
      invitedBy: inviter.userId,
    });
  }

  await db.transaction((tx) =>
    appendAudit(tx, inviter.tenantId, { actor: 'owner', action: 'member_invited', detail: { invitee_e164: e164, role } }),
  );
  return { kind: 'invited', role, inviteE164: e164 };
}

export type AcceptOutcome =
  | { kind: 'accepted'; tenantId: string; businessName: string; role: Role }
  | { kind: 'no_invite' };

/**
 * A number that was invited messages to accept. Activates the pending invite for
 * THIS sender only (so nobody can accept on another's behalf), audit-logs it, and
 * returns the new membership. Exactly-once: flipping invited→active is idempotent.
 */
export async function acceptInvite(db: Db, fromE164: string): Promise<AcceptOutcome> {
  const e164 = fromE164.replace(/[\s-]/g, '');
  const pending = await db
    .select({
      membershipId: memberships.id,
      tenantId: tenants.id,
      businessName: tenants.businessName,
      role: memberships.role,
    })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.status, 'invited')))
    .innerJoin(tenants, and(eq(tenants.id, memberships.tenantId), eq(tenants.status, 'active')))
    .where(eq(users.whatsappE164, e164))
    .limit(1);
  const row = pending[0];
  if (!row) return { kind: 'no_invite' };

  await db
    .update(memberships)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(memberships.id, row.membershipId));
  await db.transaction((tx) =>
    appendAudit(tx, row.tenantId, { actor: 'system', action: 'member_joined', detail: { e164, role: row.role } }),
  );
  return { kind: 'accepted', tenantId: row.tenantId, businessName: row.businessName, role: row.role as Role };
}
