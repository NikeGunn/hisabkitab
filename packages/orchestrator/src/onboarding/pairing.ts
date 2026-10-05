/**
 * Onboarding & pairing (PRD v1.0 §13). Binding requires BOTH the out-of-band
 * code and control of the WhatsApp number. Runs on the hisab_orch connection
 * (cross-tenant by design — the orchestrator is the tenancy trust root).
 */
import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { appendAudit, schema, type Db, type Tx } from '@hisab/db';
import { SIGNUP_MAX_FAILED_ATTEMPTS, TRIAL_DAYS, startTrial, type PlanCode } from '@hisab/shared';

export const PAIRING_TTL_MINUTES = 15;

const START_RE = /^\s*START\s+(\d{4,8})\s*$/i;
/** A pasted code on its own ("482913") — only honoured for a code bound to the sender. */
const BARE_CODE_RE = /^\s*(\d{6})\s*$/;

export interface IssueCodeOptions {
  /**
   * Bind the code to the WhatsApp number it is being sent to. A bound code only
   * pairs when `START <code>` comes FROM that number, so a leaked/guessed code is
   * useless to anyone else. Any earlier unused code for the tenant is revoked.
   */
  phoneE164?: string;
  /** 4 (admin hand-out, default) or 6 (sent by WhatsApp to the owner). */
  digits?: 4 | 6;
}

/** Mint a one-time code for a pending tenant (handed out-of-band or sent via WhatsApp). */
export async function issuePairingCode(db: Db | Tx, tenantId: string, opts: IssueCodeOptions = {}): Promise<string> {
  const digits = opts.digits ?? 4;
  const lo = 10 ** (digits - 1);
  if (opts.phoneE164) {
    // one live code per tenant: re-sending revokes the previous one
    await db
      .update(schema.pairingCodes)
      .set({ expiresAt: sql`now()` })
      .where(and(eq(schema.pairingCodes.tenantId, tenantId), isNull(schema.pairingCodes.consumedAt)));
  }
  // retry on the (unlikely) PK collision; ON CONFLICT (not try/catch) so this is
  // also safe inside a caller's transaction (a failed INSERT would abort it).
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = String(randomInt(lo, lo * 10));
    const inserted = await db
      .insert(schema.pairingCodes)
      .values({
        code,
        tenantId,
        // DB clock everywhere for code expiry: host/container clock skew must never
        // revive a burned code or kill a fresh one.
        expiresAt: sql`now() + make_interval(mins => ${PAIRING_TTL_MINUTES})`,
        ...(opts.phoneE164 ? { phoneE164: opts.phoneE164 } : {}),
      })
      .onConflictDoNothing()
      .returning({ code: schema.pairingCodes.code });
    if (inserted.length > 0) return code;
  }
  throw new Error('could not allocate a pairing code');
}

export type PairingOutcome =
  | { kind: 'paired'; tenantId: string; businessName: string }
  | { kind: 'invalid_code' }
  | { kind: 'no_code' };

/**
 * Unknown sender sent `text`. If it is a valid `START <code>`, bind the number,
 * activate the tenant, consume the code, audit-log the pairing.
 */
export async function handleUnknownSender(
  db: Db,
  fromE164: string,
  text: string | undefined,
  opts: { trialPlan?: PlanCode; now?: Date } = {},
): Promise<PairingOutcome> {
  const started = text?.match(START_RE)?.[1];
  const bare = started ? undefined : text?.match(BARE_CODE_RE)?.[1];
  const code = started ?? bare;
  if (!code) return { kind: 'no_code' };

  const outcome = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        code: schema.pairingCodes.code,
        tenantId: schema.pairingCodes.tenantId,
        businessName: schema.tenants.businessName,
        phoneE164: schema.pairingCodes.phoneE164,
      })
      .from(schema.pairingCodes)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.pairingCodes.tenantId))
      .where(
        and(
          eq(schema.pairingCodes.code, code),
          isNull(schema.pairingCodes.consumedAt),
          gt(schema.pairingCodes.expiresAt, sql`now()`),
        ),
      )
      .for('update');
    const found = rows[0];
    // A bound code pairs ONLY from its own number (same answer as a wrong code, so
    // a probe learns nothing). A bare pasted code is only accepted when bound.
    if (!found || (found.phoneE164 ? found.phoneE164 !== fromE164 : bare !== undefined)) {
      return { kind: 'invalid_code' as const };
    }

    await tx
      .update(schema.pairingCodes)
      .set({ consumedAt: new Date() })
      .where(eq(schema.pairingCodes.code, found.code));
    await tx
      .update(schema.tenants)
      .set({ whatsappE164: fromE164, status: 'active' })
      .where(eq(schema.tenants.id, found.tenantId));

    // P8: the paired number is this business's OWNER. Create the identity + an
    // active owner membership so resolveMembership returns owner from now on.
    // Both upserts are idempotent (re-pairing the same number is a no-op).
    const [u] = await tx
      .insert(schema.users)
      .values({ whatsappE164: fromE164 })
      .onConflictDoNothing()
      .returning({ id: schema.users.id });
    const ownerId =
      u?.id ??
      (await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.whatsappE164, fromE164)))[0]!
        .id;
    await tx
      .insert(schema.memberships)
      .values({ userId: ownerId, tenantId: found.tenantId, role: 'owner', status: 'active' })
      .onConflictDoNothing();

    // Every verified business starts on a free trial (idempotent: an existing
    // subscription — e.g. re-pairing — is left untouched).
    if (opts.trialPlan) {
      const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
      const trial = startTrial(today, TRIAL_DAYS);
      await tx
        .insert(schema.subscriptions)
        .values({
          tenantId: found.tenantId,
          planCode: opts.trialPlan,
          status: trial.status,
          currentPeriodEnd: trial.currentPeriodEnd,
        })
        .onConflictDoNothing();
    }

    await appendAudit(tx, found.tenantId, { actor: 'system', action: 'whatsapp_paired', detail: { fromE164 } });
    return { kind: 'paired' as const, tenantId: found.tenantId, businessName: found.businessName };
  });

  if (outcome.kind === 'invalid_code') await countFailedAttempt(db, fromE164);
  return outcome;
}

/**
 * A wrong code from a number that HAS a live bound code counts against that code;
 * after SIGNUP_MAX_FAILED_ATTEMPTS it is burned (owner must request a new one).
 */
async function countFailedAttempt(db: Db, fromE164: string): Promise<void> {
  await db
    .update(schema.pairingCodes)
    .set({
      failedAttempts: sql`${schema.pairingCodes.failedAttempts} + 1`,
      expiresAt: sql`CASE WHEN ${schema.pairingCodes.failedAttempts} + 1 >= ${SIGNUP_MAX_FAILED_ATTEMPTS}
                     THEN now() ELSE ${schema.pairingCodes.expiresAt} END`,
    })
    .where(
      and(
        eq(schema.pairingCodes.phoneE164, fromE164),
        isNull(schema.pairingCodes.consumedAt),
        gt(schema.pairingCodes.expiresAt, sql`now()`),
      ),
    );
}

/** Known active tenant for a sender, or null. */
export async function findTenantBySender(
  db: Db,
  fromE164: string,
): Promise<{ tenantId: string; businessName: string } | null> {
  const rows = await db
    .select({ tenantId: schema.tenants.id, businessName: schema.tenants.businessName })
    .from(schema.tenants)
    .where(and(eq(schema.tenants.whatsappE164, fromE164), eq(schema.tenants.status, 'active')))
    .limit(1);
  return rows[0] ?? null;
}

export const ONBOARDING_PROMPT =
  'Namaste! 🙏 This is HisabKitab, a bookkeeping assistant for VAT-registered businesses. ' +
  'If you have a verification code, reply: START <code>. ' +
  'New here? Sign up in one minute at https://hisabkitab.pro/pilot and we will send your code.';

/**
 * Auditor disclaimer surfaced at signup (PRD v2.0 §9 "Legal"): HisabKitab assists
 * with bookkeeping/VAT prep but is NOT a licensed auditor and does NOT provide
 * statutory sign-off; the owner remains responsible for what they file. Kept as a
 * single exported constant so it can be reused (privacy doc, /pay page) + tested.
 */
export const AUDITOR_DISCLAIMER =
  'Please note: HisabKitab helps you keep records and prepare VAT/TDS figures — it is assistance, ' +
  'not a substitute for a licensed auditor, and it does not provide statutory sign-off. You always ' +
  'review and file with the IRD yourself. Full terms: https://hisabkitab.pro/terms';

export const pairedWelcome = (businessName: string): string =>
  `You're all set, ${businessName}! 🎉 Send me a photo of any bill, or tell me today's sales — ` +
  `for example: "add catering 9000". I'll always show you what I read before saving anything.\n\n` +
  AUDITOR_DISCLAIMER;
