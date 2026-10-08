/**
 * Self-serve signup (hisabkitab.pro/pilot → POST /signup).
 *
 * With `signup.require_approval` on (default) the form only records an
 * APPLICATION (pending tenant, review_status 'awaiting'): no code, no WhatsApp
 * spend. The operator approves it in the admin panel, which notifies the owner;
 * the owner's first message FROM that number then activates the business.
 * Re-submitting the form while approved (e.g. the owner missed our message)
 * falls through to the code flow below.
 *
 * Without approval:
 *   form → validate → (pending tenant, number-bound 6-digit code) → WhatsApp
 *   `pairing_code` AUTHENTICATION template to the CLAIMED number → owner sends
 *   `START <code>` (or pastes the code) FROM that number → pairing.ts binds it,
 *   activates the tenant and starts the trial.
 *
 * Nothing on the form is authority: the number becomes the owner's identity only
 * after the owner proves control of it on WhatsApp. Abuse controls (each code is a
 * paid Meta authentication message): honeypot, per-IP bucket (route layer),
 * per-number daily limit, global daily cap, one live code per business.
 */
import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { appendAudit, encPII, schema, type Db } from '@hisab/db';
import {
  SIGNUP_CODES_PER_NUMBER_PER_DAY,
  SIGNUP_CODE_TTL_MINUTES,
  isBotSubmission,
  signupInputSchema,
} from '@hisab/shared';
import { issuePairingCode } from '../onboarding/pairing.js';
import { PAIRING_TEMPLATE, recordAccepted } from '../onboarding/delivery.js';
import { WaError } from '../whatsapp/wa-client.js';

export { PAIRING_TEMPLATE };
export const ADMIN_SIGNUP_ALERT_TEMPLATE = 'admin_account_update';

export interface SignupSettings {
  enabled(): boolean;
  dailyCap(): number;
  /** Public sender number (+977…) for the wa.me deep link; undefined = not set. */
  senderE164(): string | undefined;
  /** Admin's WhatsApp for new-signup alerts; undefined/empty = off. */
  alertE164(): string | undefined;
  /**
   * true = the form only records an APPLICATION; no code is sent until the
   * operator approves it in the admin panel. Omitted = false (code sent at once).
   */
  requireApproval?(): boolean;
}

export interface SignupDeps {
  db: Db; // hisab_orch
  /** Resolves to Meta's message id (wamid) when known, so delivery can be tracked. */
  sendAuthCode(to: string, template: string, code: string): Promise<string | void>;
  sendTemplate(to: string, template: string, params: string[]): Promise<string | void>;
  settings: SignupSettings;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

export type SignupResult =
  | { status: 'code_sent'; sender_e164?: string; wa_link?: string; expires_minutes: number }
  /** Application recorded; the operator reviews it. `resubmitted` = it was already on file. */
  | { status: 'under_review'; resubmitted: boolean; sender_e164?: string; wa_link?: string }
  | { status: 'invalid'; errors: Record<string, string> }
  | { status: 'closed' }
  | { status: 'busy' }
  | { status: 'rate_limited' }
  | { status: 'already_registered'; sender_e164?: string; wa_link?: string }
  | { status: 'send_failed'; reason: SendFailureReason };

/**
 * Why a code could not be delivered. `recipient` = the owner's number can't get
 * it (not on WhatsApp, or it is our own sender); anything else is OUR side (sender
 * still a test number → #131030, bad token, template, Meta outage) and must never
 * be blamed on the owner.
 */
export type SendFailureReason = 'recipient' | 'service';

/** Meta codes that mean "this recipient cannot receive", not "our sender is broken". */
const RECIPIENT_META_CODES = new Set([
  131026, // message undeliverable: not on WhatsApp / outdated app / not accepted terms
  131021, // recipient is the sender's own number
]);

export function classifySendFailure(err: unknown): SendFailureReason {
  return err instanceof WaError && err.metaCode !== undefined && RECIPIENT_META_CODES.has(err.metaCode)
    ? 'recipient'
    : 'service';
}

/**
 * Is `phone` our own WhatsApp sender? A business registered on it could never be
 * verified (WhatsApp cannot message itself, Meta #131021) and would hijack the
 * number's inbound once it becomes the sender. Compared digit-for-digit.
 */
export function isOwnSender(phone: string, senderE164: string | undefined): boolean {
  const digits = (s: string) => s.replace(/\D/g, '');
  return Boolean(senderE164) && digits(phone) !== '' && digits(phone) === digits(senderE164!);
}

/** wa.me link that opens a chat with HisabKitab pre-filled with "START ". */
export function waLink(senderE164: string | undefined): string | undefined {
  if (!senderE164) return undefined;
  return `https://wa.me/${senderE164.replace(/^\+/, '')}?text=${encodeURIComponent('START ')}`;
}

export async function handleSignup(deps: SignupDeps, body: unknown): Promise<SignupResult> {
  const now = deps.now?.() ?? new Date();
  const sender = deps.settings.senderE164() || undefined;

  let input;
  try {
    input = signupInputSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      const errors: Record<string, string> = {};
      for (const issue of err.issues) {
        const field = String(issue.path[0] ?? 'form');
        errors[field] ??= issue.message;
      }
      return { status: 'invalid', errors };
    }
    throw err;
  }

  // Bot: pretend success, do nothing (no template spend, no row).
  if (isBotSubmission(input)) {
    deps.log?.('signup honeypot tripped');
    return deps.settings.requireApproval?.()
      ? { status: 'under_review', resubmitted: false }
      : { status: 'code_sent', expires_minutes: SIGNUP_CODE_TTL_MINUTES };
  }
  if (!deps.settings.enabled()) return { status: 'closed' };

  const phone = input.whatsapp;
  if (isOwnSender(phone, sender)) {
    return {
      status: 'invalid',
      errors: { whatsapp: "That is HisabKitab's own WhatsApp number. Enter the business owner's WhatsApp number." },
    };
  }
  const dayAgo = new Date(now.getTime() - 86_400_000);

  // All decisions for one number happen under a per-number advisory lock, so two
  // racing submissions can never create two pending businesses or exceed limits.
  const decision = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'signup:' + phone}))`);

    const [{ n: sentToday } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.pairingCodes)
      .where(
        and(
          isNotNull(schema.pairingCodes.phoneE164),
          isNull(schema.pairingCodes.sendFailedAt),
          gt(schema.pairingCodes.createdAt, dayAgo),
        ),
      );
    if (sentToday >= deps.settings.dailyCap()) return { kind: 'busy' as const };

    const [{ n: forNumber } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.pairingCodes)
      // an undelivered code (send_failed_at) cost nothing and reached no one
      .where(
        and(
          eq(schema.pairingCodes.phoneE164, phone),
          isNull(schema.pairingCodes.sendFailedAt),
          gt(schema.pairingCodes.createdAt, dayAgo),
        ),
      );
    if (forNumber >= SIGNUP_CODES_PER_NUMBER_PER_DAY) return { kind: 'rate_limited' as const };

    // Already an active member of any business? They should just message us.
    const [member] = await tx
      .select({ id: schema.memberships.id })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(and(eq(schema.users.whatsappE164, phone), eq(schema.memberships.status, 'active')))
      .limit(1);
    const [owned] = await tx
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.whatsappE164, phone))
      .limit(1);
    if (member || owned) return { kind: 'already_registered' as const };

    const fields = {
      businessName: input.business_name,
      ownerName: input.owner_name,
      panOrVatNo: encPII(input.pan_vat) as string,
      vatRegistered: input.vat_registered,
      contactEmail: input.email ?? null,
      signupSource: 'web' as const,
    };

    // This number's still-pending website application, if any.
    const [application] = await tx
      .select({ id: schema.tenants.id, review: schema.tenants.reviewStatus })
      .from(schema.tenants)
      .where(
        and(
          eq(schema.tenants.applicantE164, phone),
          eq(schema.tenants.status, 'pending'),
          isNotNull(schema.tenants.reviewStatus),
        ),
      )
      .orderBy(desc(schema.tenants.createdAt))
      .limit(1);

    if (deps.settings.requireApproval?.() && application?.review !== 'approved') {
      if (application) {
        // Same number again: refresh the details; a declined one goes back in the queue.
        await tx
          .update(schema.tenants)
          .set({ ...fields, reviewStatus: 'awaiting', reviewedAt: null })
          .where(eq(schema.tenants.id, application.id));
        await appendAudit(tx, application.id, {
          actor: 'system',
          action: 'signup.reapplied',
          detail: { source: 'web', was: application.review },
        });
        return { kind: 'applied' as const, tenantId: application.id, fresh: application.review === 'declined' };
      }
      // applications cost nothing to send, but the queue is still capped per day
      const [{ n: appliedToday } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.tenants)
        .where(and(isNotNull(schema.tenants.reviewStatus), gt(schema.tenants.createdAt, dayAgo)));
      if (appliedToday >= deps.settings.dailyCap()) return { kind: 'busy' as const };

      const [t] = await tx
        .insert(schema.tenants)
        .values({ ...fields, reviewStatus: 'awaiting', applicantE164: phone })
        .returning({ id: schema.tenants.id });
      await appendAudit(tx, t!.id, { actor: 'system', action: 'signup.applied', detail: { source: 'web' } });
      return { kind: 'applied' as const, tenantId: t!.id, fresh: true };
    }

    // Re-use this number's still-pending business (a resend), else create one.
    const [pending] = application
      ? [{ tenantId: application.id }]
      : await tx
          .select({ tenantId: schema.pairingCodes.tenantId })
          .from(schema.pairingCodes)
          .innerJoin(schema.tenants, eq(schema.tenants.id, schema.pairingCodes.tenantId))
          .where(and(eq(schema.pairingCodes.phoneE164, phone), eq(schema.tenants.status, 'pending')))
          .orderBy(desc(schema.pairingCodes.createdAt))
          .limit(1);

    let tenantId: string;
    if (application?.review === 'approved') {
      // approved earlier, owner missed our message: keep the reviewed details, just send a code
      tenantId = application.id;
    } else if (pending) {
      tenantId = pending.tenantId;
      // review switched off while this application waited: sending a code approves it
      await tx
        .update(schema.tenants)
        .set(application ? { ...fields, reviewStatus: 'approved', reviewedAt: sql`now()` } : fields)
        .where(eq(schema.tenants.id, tenantId));
    } else {
      const [t] = await tx.insert(schema.tenants).values(fields).returning({ id: schema.tenants.id });
      tenantId = t!.id;
    }
    const code = await issuePairingCode(tx, tenantId, { phoneE164: phone, digits: 6 });
    await appendAudit(tx, tenantId, {
      actor: 'system',
      action: 'signup.code_issued',
      detail: { source: 'web', resend: Boolean(pending) },
    });
    return { kind: 'issue' as const, tenantId, code, resend: Boolean(pending) };
  });

  if (decision.kind === 'busy') return { status: 'busy' };
  if (decision.kind === 'applied') {
    await deps.db.insert(schema.adminEvents).values({
      actor: 'website',
      action: decision.fresh ? 'signup.applied' : 'signup.reapplied',
      detail: { tenant_id: decision.tenantId, business: input.business_name, phone_tail: phone.slice(-4) },
    });
    const alertTo = deps.settings.alertE164();
    if (alertTo && decision.fresh) {
      // best-effort: an alert failure must never fail the owner's application
      await deps
        .sendTemplate(alertTo, ADMIN_SIGNUP_ALERT_TEMPLATE, [input.business_name])
        .catch((err) => deps.log?.('admin signup alert failed', { error: String(err) }));
    }
    const link = waLink(sender);
    return {
      status: 'under_review',
      resubmitted: !decision.fresh,
      ...(sender ? { sender_e164: sender } : {}),
      ...(link ? { wa_link: link } : {}),
    };
  }
  if (decision.kind === 'rate_limited') return { status: 'rate_limited' };
  if (decision.kind === 'already_registered') {
    const link = waLink(sender);
    return { status: 'already_registered', ...(sender ? { sender_e164: sender } : {}), ...(link ? { wa_link: link } : {}) };
  }

  try {
    const waMessageId = await deps.sendAuthCode(phone, PAIRING_TEMPLATE, decision.code);
    // accepted is not delivered: the status webhook settles it (and retries a failure)
    await recordAccepted(deps.db, { tenantId: decision.tenantId, to: phone, kind: 'signup_code', waMessageId, attempt: 1 });
  } catch (err) {
    // Burn the code we could not deliver (and say so) — never leave a usable code
    // the owner never received. Mark it undelivered so it doesn't count against
    // the owner's limits (Meta does not bill a refused message).
    await deps.db
      .update(schema.pairingCodes)
      .set({ expiresAt: sql`now()`, sendFailedAt: sql`now()` })
      .where(eq(schema.pairingCodes.code, decision.code));
    const reason = classifySendFailure(err);
    const metaCode = err instanceof WaError ? err.metaCode : undefined;
    deps.log?.(reason === 'service' ? 'signup code send failed: SENDER/SERVICE problem' : 'signup code send failed', {
      reason,
      meta_code: metaCode,
      error: String(err),
    });
    // visible on the admin panel: a service failure means every signup is failing
    await deps.db.insert(schema.adminEvents).values({
      actor: 'website',
      action: 'signup.send_failed',
      detail: { tenant_id: decision.tenantId, reason, meta_code: metaCode ?? null, phone_tail: phone.slice(-4) },
    });
    return { status: 'send_failed', reason };
  }

  await deps.db.insert(schema.adminEvents).values({
    actor: 'website',
    action: decision.resend ? 'signup.code_resent' : 'signup.created',
    detail: { tenant_id: decision.tenantId, business: input.business_name, phone_tail: phone.slice(-4) },
  });

  const alertTo = deps.settings.alertE164();
  if (alertTo && !decision.resend) {
    // best-effort: an alert failure must never fail the owner's signup
    await deps
      .sendTemplate(alertTo, ADMIN_SIGNUP_ALERT_TEMPLATE, [input.business_name])
      .catch((err) => deps.log?.('admin signup alert failed', { error: String(err) }));
  }

  const link = waLink(sender);
  return {
    status: 'code_sent',
    ...(sender ? { sender_e164: sender } : {}),
    ...(link ? { wa_link: link } : {}),
    expires_minutes: SIGNUP_CODE_TTL_MINUTES,
  };
}
