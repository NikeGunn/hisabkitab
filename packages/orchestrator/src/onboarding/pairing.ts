/**
 * Onboarding & pairing (PRD v1.0 §13). Binding requires BOTH the out-of-band
 * code and control of the WhatsApp number. Runs on the hisab_orch connection
 * (cross-tenant by design — the orchestrator is the tenancy trust root).
 */
import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { appendAudit, schema, type Db } from '@hisab/db';

export const PAIRING_TTL_MINUTES = 15;

const START_RE = /^\s*START\s+(\d{4,8})\s*$/i;

/** Admin-side: mint a one-time code for a pending tenant (give it out-of-band). */
export async function issuePairingCode(db: Db, tenantId: string): Promise<string> {
  // retry on the (unlikely) PK collision of a 4-digit code
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(randomInt(1000, 10000));
    try {
      await db.insert(schema.pairingCodes).values({
        code,
        tenantId,
        expiresAt: new Date(Date.now() + PAIRING_TTL_MINUTES * 60_000),
      });
      return code;
    } catch {
      /* collision — try another code */
    }
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
): Promise<PairingOutcome> {
  const match = text?.match(START_RE);
  if (!match) return { kind: 'no_code' };
  const code = match[1] as string;

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        code: schema.pairingCodes.code,
        tenantId: schema.pairingCodes.tenantId,
        businessName: schema.tenants.businessName,
      })
      .from(schema.pairingCodes)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.pairingCodes.tenantId))
      .where(
        and(
          eq(schema.pairingCodes.code, code),
          isNull(schema.pairingCodes.consumedAt),
          gt(schema.pairingCodes.expiresAt, new Date()),
        ),
      )
      .for('update');
    const found = rows[0];
    if (!found) return { kind: 'invalid_code' as const };

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

    await appendAudit(tx, found.tenantId, { actor: 'system', action: 'whatsapp_paired', detail: { fromE164 } });
    return { kind: 'paired' as const, tenantId: found.tenantId, businessName: found.businessName };
  });
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
  'Namaste! 🙏 This is HisabKitab, a bookkeeping assistant for registered businesses. ' +
  'If you have a pairing code, reply: START <code>. ' +
  'If not, please contact us to sign up your business first.';

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
