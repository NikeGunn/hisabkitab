/**
 * Identity, RBAC resolution and TEAM ACCESS (PRD v2.0 §3). The orchestrator is the
 * tenancy trust root: it maps a VERIFIED WhatsApp sender (from the signed webhook,
 * never free text) to `(user, tenant, role)` before any agent turn runs, and owns
 * the one team-access core that BOTH surfaces drive:
 *   - the owner over WhatsApp ("add 98XXXXXXXX as auditor for 30 days", "team",
 *     "change 98XXXXXXXX to viewer", "remove 98XXXXXXXX"), and
 *   - the operator in the admin panel (Businesses → Team).
 * All of this is on the hisab_orch connection (cross-tenant by design).
 *
 * Security invariants (why this is safe against misuse over WhatsApp):
 *   - The ACTOR identity is always `msg.fromE164` from the signed webhook payload.
 *     A message body claiming "I am the owner / add me as owner" is data, never
 *     authority — resolveMembership ignores it entirely.
 *   - Managing the team is OWNER-ONLY over chat, checked server-side (resolved
 *     role === 'owner'); the admin path is behind the admin session + CSRF.
 *   - An invite only grants a role once the INVITED number itself messages to
 *     accept (it must control that WhatsApp). Nobody — owner or operator — can
 *     bind someone else's number silently; the invitee gets only the offered role.
 *   - The owner role is never granted, changed, expired or removed here (no
 *     lockout, no ownership transfer by chat). Re-inviting is idempotent.
 *   - Plan seat limits are checked under a per-tenant advisory lock, so two
 *     concurrent invites can never both take the last seat.
 *   - Expiry is checked on EVERY message (resolveMembership), on the DB clock.
 */
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { appendAudit, schema, type Db } from '@hisab/db';
import { checkTeamSeat, normalizePhone, planName, type PlanCode, type Role } from '@hisab/shared';

const { users, memberships, tenants, subscriptions } = schema;

/** Roles that can be granted (never another owner — ownership transfer is a
 *  deliberate, separate action, not a chat command or an admin click). */
export const INVITABLE_ROLES: readonly Role[] = ['accountant', 'auditor', 'staff', 'viewer'];

/** An unanswered invite holds its seat (and can be accepted) for this long. */
export const INVITE_TTL_DAYS = 7;
/** Longest time-limited access; anything longer is "until removed". */
export const MAX_ACCESS_DAYS = 365;

/** Plain-language description of each role — ONE source for chat + admin copy. */
export const ROLE_ACCESS: Record<Role, string> = {
  owner: 'everything, including payments and team changes',
  accountant: 'record and confirm entries, prepare VAT, pull reports and check the audit trail',
  auditor: 'read every report and statement and verify the audit trail (read-only, cannot change anything)',
  staff: 'record draft entries (the owner or accountant confirms them)',
  viewer: 'view reports and summaries (read-only)',
};

// ---------------------------------------------------------------- chat commands

export type TeamCommand =
  | { kind: 'invite'; e164: string; role: Role; days: number | null }
  | { kind: 'change'; e164: string; role: Role }
  | { kind: 'remove'; e164: string }
  | { kind: 'list' }
  /** Looks like a team command but the number/days are unreadable: answer with help. */
  | { kind: 'malformed'; hint: string };

const ROLE_WORD = '(accountant|auditor|staff|viewer)';
// A phone-shaped token (digits, optional leading +, spaces/dashes inside).
const PHONE = '(\\+?[0-9][0-9 \\-]{6,18}[0-9])';
// STRICT, fully-anchored grammar: a bookkeeping message like "add 25000000 staff
// salary" must never be read as an invite, so any extra word ⇒ not a command.
const INVITE_RE = new RegExp(
  `^\\s*(?:add|invite)\\s+(?:my\\s+[a-z]+\\s+)?${PHONE}\\s+(?:as\\s+)?(?:an?\\s+)?${ROLE_WORD}(?:\\s+for\\s+(\\d{1,4})\\s+days?)?\\s*[.!]?\\s*$`,
  'i',
);
const CHANGE_RE = new RegExp(`^\\s*(?:change|make|set)\\s+${PHONE}\\s+(?:to\\s+|as\\s+|into\\s+)?(?:an?\\s+)?${ROLE_WORD}\\s*[.!]?\\s*$`, 'i');
const REMOVE_RE = new RegExp(`^\\s*(?:remove|revoke)\\s+${PHONE}(?:\\s+from\\s+(?:my\\s+)?team)?\\s*[.!]?\\s*$`, 'i');
const LIST_RE = /^\s*(?:team|my team|show (?:my )?team|who has access)\s*[?.!]?\s*$/i;

/**
 * Parse an owner's team command. Returns null for anything that isn't one (it then
 * goes to the agent as a normal message). The role keyword must be explicit — it
 * is never guessed — and the number must be a real WhatsApp mobile.
 */
export function parseTeamCommand(text: string | undefined): TeamCommand | null {
  if (!text || text.length > 200) return null;
  if (LIST_RE.test(text)) return { kind: 'list' };
  const inv = INVITE_RE.exec(text);
  if (inv) {
    const e164 = normalizePhone(inv[1]!);
    if (!e164) return { kind: 'malformed', hint: 'number' };
    const days = inv[3] ? Number(inv[3]) : null;
    if (days !== null && (days < 1 || days > MAX_ACCESS_DAYS)) return { kind: 'malformed', hint: 'days' };
    return { kind: 'invite', e164, role: inv[2]!.toLowerCase() as Role, days };
  }
  const ch = CHANGE_RE.exec(text);
  if (ch) {
    const e164 = normalizePhone(ch[1]!);
    return e164 ? { kind: 'change', e164, role: ch[2]!.toLowerCase() as Role } : { kind: 'malformed', hint: 'number' };
  }
  const rm = REMOVE_RE.exec(text);
  if (rm) {
    const e164 = normalizePhone(rm[1]!);
    return e164 ? { kind: 'remove', e164 } : { kind: 'malformed', hint: 'number' };
  }
  return null;
}

/** True if a sender's text is an invite acceptance ("JOIN" / "YES" / "accept"). */
export function isAcceptCommand(text: string | undefined): boolean {
  return !!text && /^\s*(join|accept|yes)\b/i.test(text);
}

// ---------------------------------------------------------------- resolution

/** A resolved caller: which business they're acting on and with what authority. */
export interface ResolvedMembership {
  userId: string;
  tenantId: string;
  businessName: string;
  role: Role;
}

/** SQL predicate: the membership's access window has not ended (DB clock). */
const notExpired = () => or(isNull(memberships.expiresAt), gt(memberships.expiresAt, sql`now()`));

/**
 * Resolve the active, unexpired `(user, tenant, role)` for a verified sender, or
 * null if the number has no live membership. Single indexed join (users.whatsapp_e164
 * → memberships → tenants); no per-row work.
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
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.status, 'active'), notExpired()))
    .innerJoin(tenants, and(eq(tenants.id, memberships.tenantId), eq(tenants.status, 'active')))
    .where(eq(users.whatsappE164, fromE164))
    .orderBy(memberships.createdAt, memberships.tenantId)
    .limit(1);
  const row = rows[0];
  return row ? { ...row, role: row.role as Role } : null;
}

/**
 * The sender has no ACTIVE business, but is an active member of a SUSPENDED one
 * (the operator paused it). Lets the router answer "your account is paused"
 * instead of the new-signup prompt — which would send the owner to a signup form
 * that tells them they are already registered (a loop).
 */
export async function isMemberOfSuspendedTenant(db: Db, fromE164: string): Promise<boolean> {
  const rows = await db
    .select({ id: tenants.id })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.status, 'active'), notExpired()))
    .innerJoin(tenants, and(eq(tenants.id, memberships.tenantId), eq(tenants.status, 'suspended')))
    .where(eq(users.whatsappE164, fromE164))
    .limit(1);
  return rows.length > 0;
}

/**
 * The sender has no live access, but USED to (removed, or the time-limited access
 * ran out). Lets the router say so plainly instead of the new-signup prompt.
 */
export async function endedAccess(
  db: Db,
  fromE164: string,
): Promise<{ businessName: string; why: 'expired' | 'removed' } | null> {
  const rows = await db
    .select({ businessName: tenants.businessName, status: memberships.status, updatedAt: memberships.updatedAt })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(
      and(
        eq(users.whatsappE164, fromE164),
        or(eq(memberships.status, 'revoked'), and(eq(memberships.status, 'active'), sql`${memberships.expiresAt} <= now()`)),
      ),
    )
    .orderBy(desc(memberships.updatedAt))
    .limit(1);
  const row = rows[0];
  return row ? { businessName: row.businessName, why: row.status === 'revoked' ? 'removed' : 'expired' } : null;
}

// ---------------------------------------------------------------- team management

/** Who is managing the team: the owner over chat, or the operator in the admin panel. */
export type TeamActor =
  | { via: 'chat'; member: ResolvedMembership }
  | { via: 'admin'; tenantId: string; /** testing/support: ignore the plan's seat + role limits */ overridePlan?: boolean };

const actorTenant = (a: TeamActor) => (a.via === 'chat' ? a.member.tenantId : a.tenantId);
/** Over chat only the OWNER may manage the team; the admin session is checked by the panel. */
const authorized = (a: TeamActor) => a.via === 'admin' || a.member.role === 'owner';
/** Audit actor + `by` detail (admin actions are 'system' with by:'admin', like the rest of the panel). */
const auditActor = (a: TeamActor) => (a.via === 'chat' ? ('owner' as const) : ('system' as const));

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Serialize every team change for one business (seat counting must not race). */
const lockTeam = (tx: Tx, tenantId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'team:' + tenantId}, 0))`);

/** Find-or-create the global user row for a verified WhatsApp number. */
async function ensureUser(db: Db | Tx, e164: string): Promise<string> {
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

/**
 * The business's plan for seat limits. No subscription row ⇒ the strictest real
 * plan (starter), never "unlimited" — same deny-by-default as the cost budgets.
 */
export async function teamPlan(db: Db | Tx, tenantId: string): Promise<PlanCode> {
  const [row] = await db
    .select({ plan: subscriptions.planCode })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  const plan = row?.plan;
  return plan === 'pro' || plan === 'business' ? plan : 'starter';
}

/**
 * Seats in use (owner included): active unexpired members + invites that are
 * still answerable. An expired, removed or stale-invite row frees its seat.
 * `excludeUserId` leaves out the row being re-invited (it is not a NEW seat).
 */
export async function seatsUsed(db: Db | Tx, tenantId: string, excludeUserId?: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        notExpired(),
        or(
          eq(memberships.status, 'active'),
          and(eq(memberships.status, 'invited'), sql`${memberships.updatedAt} > now() - make_interval(days => ${INVITE_TTL_DAYS})`),
        ),
        excludeUserId ? sql`${memberships.userId} <> ${excludeUserId}` : undefined,
      ),
    );
  return row?.n ?? 0;
}

export type InviteResult =
  | { kind: 'invited'; role: Role; inviteE164: string; businessName: string; expiresAt: Date | null; overridden: boolean }
  | { kind: 'not_owner' } // caller lacks authority
  | { kind: 'already_member'; role: Role } // invitee already active on this business
  | { kind: 'busy_elsewhere' } // number is already active on ANOTHER business
  | { kind: 'seat_limit'; plan: PlanCode; seats: number; used: number }
  | { kind: 'role_not_in_plan'; plan: PlanCode; role: Role; minPlan: PlanCode | null }
  | { kind: 'tenant_inactive' }
  | { kind: 'bad_role' }
  | { kind: 'bad_days' }
  | { kind: 'bad_number' };

/**
 * Invite `inviteE164` to the actor's business as `role`, optionally for `days`
 * (access ends that many days from now; null = until removed). Creates/refreshes
 * an `invited` membership; the invitee must accept from that number (acceptInvite).
 * Authority comes from the verified session / admin session, NEVER message text.
 */
export async function inviteMember(
  db: Db,
  actor: TeamActor,
  inviteE164: string,
  role: Role,
  opts: { days?: number | null } = {},
): Promise<InviteResult> {
  if (!authorized(actor)) return { kind: 'not_owner' };
  if (!INVITABLE_ROLES.includes(role)) return { kind: 'bad_role' };
  const e164 = normalizePhone(inviteE164);
  if (!e164) return { kind: 'bad_number' };
  const days = opts.days ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_ACCESS_DAYS)) return { kind: 'bad_days' };
  const tenantId = actorTenant(actor);

  return db.transaction(async (tx) => {
    await lockTeam(tx, tenantId);
    const [t] = await tx
      .select({ status: tenants.status, name: tenants.businessName })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t || t.status !== 'active') return { kind: 'tenant_inactive' } as const;

    const inviteeId = await ensureUser(tx, e164);

    // the live row (invited|active, expired or not) for this person on this business
    const [live] = await tx
      .select({
        id: memberships.id,
        role: memberships.role,
        status: memberships.status,
        unexpired: sql<boolean>`(${memberships.expiresAt} is null or ${memberships.expiresAt} > now())`,
      })
      .from(memberships)
      .where(and(eq(memberships.userId, inviteeId), eq(memberships.tenantId, tenantId), sql`status <> 'revoked'`))
      .limit(1);
    if (live?.status === 'active' && live.unexpired) return { kind: 'already_member', role: live.role as Role } as const;

    // One number = one business until "switch business" (§4) exists: an identity
    // active elsewhere would keep landing on its OTHER business, so refuse up front.
    const [elsewhere] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, inviteeId),
          eq(memberships.status, 'active'),
          notExpired(),
          sql`${memberships.tenantId} <> ${tenantId}`,
          sql`${tenants.status} <> 'deleted'`,
        ),
      )
      .limit(1);
    if (elsewhere) return { kind: 'busy_elsewhere' } as const;

    const plan = await teamPlan(tx, tenantId);
    const overridden = actor.via === 'admin' && actor.overridePlan === true;
    const check = checkTeamSeat(plan, role, await seatsUsed(tx, tenantId, inviteeId));
    if (!check.ok && !overridden) {
      return check.reason === 'role_not_in_plan'
        ? ({ kind: 'role_not_in_plan', plan, role, minPlan: check.minPlan } as const)
        : ({ kind: 'seat_limit', plan, seats: check.seats, used: check.used } as const);
    }

    const expiresAt = days === null ? null : sql`now() + make_interval(days => ${days})`;
    const values = {
      role,
      status: 'invited' as const,
      invitedBy: actor.via === 'chat' ? actor.member.userId : null,
      grantedVia: actor.via,
      expiresAt,
      updatedAt: sql`now()`,
    };
    const [row] = live
      ? await tx.update(memberships).set(values).where(eq(memberships.id, live.id)).returning({ expiresAt: memberships.expiresAt })
      : await tx
          .insert(memberships)
          .values({ userId: inviteeId, tenantId, ...values })
          .returning({ expiresAt: memberships.expiresAt });

    await appendAudit(tx, tenantId, {
      actor: auditActor(actor),
      action: 'member_invited',
      detail: { by: actor.via, invitee_e164: e164, role, days, ...(overridden && !check.ok ? { plan_override: plan } : {}) },
    });
    return {
      kind: 'invited',
      role,
      inviteE164: e164,
      businessName: t.name,
      expiresAt: row?.expiresAt ?? null,
      overridden: overridden && !check.ok,
    } as const;
  });
}

export type AcceptOutcome =
  | { kind: 'accepted'; tenantId: string; businessName: string; role: Role; expiresAt: Date | null }
  | { kind: 'no_invite' };

/**
 * A number that was invited messages to accept. Activates the NEWEST answerable
 * invite for THIS sender only (so nobody can accept on another's behalf), audit-logs
 * it, and returns the new membership. Exactly-once: the flip is a conditional
 * UPDATE … WHERE status='invited', so a double JOIN activates once. The seat was
 * reserved at invite time, so accepting never exceeds the plan.
 */
export async function acceptInvite(db: Db, fromE164: string): Promise<AcceptOutcome> {
  const e164 = normalizePhone(fromE164) ?? fromE164;
  const pending = await db
    .select({
      membershipId: memberships.id,
      tenantId: tenants.id,
      businessName: tenants.businessName,
      role: memberships.role,
    })
    .from(users)
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, users.id),
        eq(memberships.status, 'invited'),
        notExpired(),
        sql`${memberships.updatedAt} > now() - make_interval(days => ${INVITE_TTL_DAYS})`,
      ),
    )
    .innerJoin(tenants, and(eq(tenants.id, memberships.tenantId), eq(tenants.status, 'active')))
    .where(eq(users.whatsappE164, e164))
    .orderBy(desc(memberships.updatedAt))
    .limit(1);
  const row = pending[0];
  if (!row) return { kind: 'no_invite' };

  return db.transaction(async (tx) => {
    const [flipped] = await tx
      .update(memberships)
      .set({ status: 'active', updatedAt: sql`now()` })
      .where(and(eq(memberships.id, row.membershipId), eq(memberships.status, 'invited')))
      .returning({ expiresAt: memberships.expiresAt });
    if (!flipped) return { kind: 'no_invite' } as const;
    await appendAudit(tx, row.tenantId, { actor: 'system', action: 'member_joined', detail: { e164, role: row.role } });
    return {
      kind: 'accepted',
      tenantId: row.tenantId,
      businessName: row.businessName,
      role: row.role as Role,
      expiresAt: flipped.expiresAt,
    } as const;
  });
}

export type ChangeResult =
  | { kind: 'changed'; e164: string; role: Role; expiresAt: Date | null }
  | { kind: 'not_owner' }
  | { kind: 'not_found' } // no current (unexpired) member/invite with that number
  | { kind: 'is_owner' }
  | { kind: 'role_not_in_plan'; plan: PlanCode; role: Role; minPlan: PlanCode | null }
  | { kind: 'bad_role' }
  | { kind: 'bad_days' }
  | { kind: 'bad_number' };

/**
 * Change a CURRENT member's role and/or access window. `days`: undefined = keep,
 * null = until removed, n = ends n days from now. Only an unexpired member/invite
 * can be changed — reviving an expired one goes through a fresh invite, so it is
 * seat-checked and has to be accepted again.
 */
export async function changeMember(
  db: Db,
  actor: TeamActor,
  targetE164: string,
  change: { role?: Role; days?: number | null },
): Promise<ChangeResult> {
  if (!authorized(actor)) return { kind: 'not_owner' };
  const e164 = normalizePhone(targetE164);
  if (!e164) return { kind: 'bad_number' };
  if (change.role !== undefined && !INVITABLE_ROLES.includes(change.role)) return { kind: 'bad_role' };
  const days = change.days;
  if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_ACCESS_DAYS)) {
    return { kind: 'bad_days' };
  }
  const tenantId = actorTenant(actor);

  return db.transaction(async (tx) => {
    await lockTeam(tx, tenantId);
    const [row] = await tx
      .select({ id: memberships.id, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(users.whatsappE164, e164),
          eq(memberships.tenantId, tenantId),
          sql`${memberships.status} <> 'revoked'`,
          notExpired(),
          or(
            eq(memberships.status, 'active'),
            sql`${memberships.updatedAt} > now() - make_interval(days => ${INVITE_TTL_DAYS})`,
          ),
        ),
      )
      .limit(1);
    if (!row) return { kind: 'not_found' } as const;
    if (row.role === 'owner') return { kind: 'is_owner' } as const;

    const role = change.role ?? (row.role as Role);
    if (role !== row.role && !(actor.via === 'admin' && actor.overridePlan)) {
      const plan = await teamPlan(tx, tenantId);
      // the member already holds a seat, so only the ROLE gate applies here
      const check = checkTeamSeat(plan, role, 0);
      if (!check.ok && check.reason === 'role_not_in_plan') {
        return { kind: 'role_not_in_plan', plan, role, minPlan: check.minPlan } as const;
      }
    }
    const [updated] = await tx
      .update(memberships)
      .set({
        role,
        ...(days === undefined ? {} : { expiresAt: days === null ? null : sql`now() + make_interval(days => ${days})` }),
        updatedAt: sql`now()`,
      })
      .where(eq(memberships.id, row.id))
      .returning({ expiresAt: memberships.expiresAt });
    await appendAudit(tx, tenantId, {
      actor: auditActor(actor),
      action: 'member_changed',
      detail: { by: actor.via, e164, from_role: row.role, role, ...(days === undefined ? {} : { days }) },
    });
    return { kind: 'changed', e164, role, expiresAt: updated?.expiresAt ?? null } as const;
  });
}

export type RemoveResult =
  | { kind: 'removed'; e164: string; role: Role }
  | { kind: 'not_owner' }
  | { kind: 'not_found' }
  | { kind: 'is_owner' }
  | { kind: 'bad_number' };

/**
 * Take someone's access away (or cancel their invite). Immediate: their next
 * message is refused. The row is kept as `revoked` (history + audit) and frees the
 * seat; the number can be invited again later. The owner can never be removed.
 */
export async function removeMember(db: Db, actor: TeamActor, targetE164: string): Promise<RemoveResult> {
  if (!authorized(actor)) return { kind: 'not_owner' };
  const e164 = normalizePhone(targetE164);
  if (!e164) return { kind: 'bad_number' };
  const tenantId = actorTenant(actor);

  return db.transaction(async (tx) => {
    await lockTeam(tx, tenantId);
    const [row] = await tx
      .select({ id: memberships.id, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(users.whatsappE164, e164), eq(memberships.tenantId, tenantId), sql`${memberships.status} <> 'revoked'`))
      .limit(1);
    if (!row) return { kind: 'not_found' } as const;
    if (row.role === 'owner') return { kind: 'is_owner' } as const;
    await tx
      .update(memberships)
      .set({ status: 'revoked', revokedAt: sql`now()`, revokedVia: actor.via, updatedAt: sql`now()` })
      .where(eq(memberships.id, row.id));
    await appendAudit(tx, tenantId, { actor: auditActor(actor), action: 'member_removed', detail: { by: actor.via, e164, role: row.role } });
    return { kind: 'removed', e164, role: row.role as Role } as const;
  });
}

/**
 * Re-open an unanswered invite for another INVITE_TTL_DAYS (admin "Resend invite").
 * A stale invite no longer holds a seat, so re-opening it is seat-checked again
 * (unless the operator overrides the plan for testing/support).
 */
export async function refreshInvite(
  db: Db,
  actor: Extract<TeamActor, { via: 'admin' }>,
  targetE164: string,
): Promise<{ kind: 'refreshed'; role: Role; e164: string } | { kind: 'not_found' } | { kind: 'seat_limit' }> {
  const e164 = normalizePhone(targetE164);
  if (!e164) return { kind: 'not_found' };
  return db.transaction(async (tx) => {
    await lockTeam(tx, actor.tenantId);
    const [row] = await tx
      .select({
        id: memberships.id,
        role: memberships.role,
        userId: memberships.userId,
        fresh: sql<boolean>`${memberships.updatedAt} > now() - make_interval(days => ${INVITE_TTL_DAYS})`,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(users.whatsappE164, e164), eq(memberships.tenantId, actor.tenantId), eq(memberships.status, 'invited'), notExpired()),
      )
      .limit(1);
    if (!row) return { kind: 'not_found' } as const;
    // A still-open invite already holds its seat; only a stale one needs a seat again.
    if (!row.fresh && !actor.overridePlan) {
      const check = checkTeamSeat(await teamPlan(tx, actor.tenantId), row.role as Role, await seatsUsed(tx, actor.tenantId, row.userId));
      if (!check.ok) return { kind: 'seat_limit' } as const;
    }
    await tx.update(memberships).set({ updatedAt: sql`now()` }).where(eq(memberships.id, row.id));
    await appendAudit(tx, actor.tenantId, { actor: 'system', action: 'member_invite_resent', detail: { by: 'admin', e164, role: row.role } });
    return { kind: 'refreshed', role: row.role as Role, e164 } as const;
  });
}

export type TeamStatus = 'active' | 'invited' | 'expired' | 'invite_expired' | 'removed';

export interface TeamRow {
  e164: string;
  role: Role;
  status: TeamStatus;
  expiresAt: Date | null;
  grantedVia: 'chat' | 'admin' | 'system';
  since: Date;
  revokedAt: Date | null;
}

/**
 * Everyone on a business, owner first, with a DERIVED status (computed on the DB
 * clock, so "expired" is exactly what resolveMembership enforces). `history`
 * includes removed/expired rows (admin view); without it only current people.
 */
export async function listTeam(db: Db, tenantId: string, opts: { history?: boolean } = {}): Promise<TeamRow[]> {
  const rows = await db
    .select({
      e164: users.whatsappE164,
      role: memberships.role,
      status: sql<TeamStatus>`case
        when ${memberships.status} = 'revoked' then 'removed'
        when ${memberships.expiresAt} is not null and ${memberships.expiresAt} <= now() then 'expired'
        when ${memberships.status} = 'invited' and ${memberships.updatedAt} <= now() - make_interval(days => ${INVITE_TTL_DAYS}) then 'invite_expired'
        else ${memberships.status} end`,
      expiresAt: memberships.expiresAt,
      grantedVia: memberships.grantedVia,
      since: memberships.createdAt,
      revokedAt: memberships.revokedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(sql`case when ${memberships.role} = 'owner' then 0 else 1 end`, desc(memberships.updatedAt))
    .limit(100);
  const out = rows.map((r) => ({ ...r, role: r.role as Role }));
  return opts.history ? out : out.filter((r) => r.status === 'active' || r.status === 'invited');
}

/** "auditor" → "an auditor" (chat + notice copy). */
export const withArticle = (role: string): string => (/^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`);

/** Plan name for owner-facing copy. */
export const planLabel = (plan: PlanCode): string => planName(plan);
