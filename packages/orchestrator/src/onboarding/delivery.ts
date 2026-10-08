/**
 * Onboarding delivery tracker + self-healing retrier (migration 0022).
 *
 *   send ──► onboarding_messages(accepted, wa_message_id)
 *   Meta status webhook ──► applyDeliveryStatus  (max-register merge, see policy)
 *        failed ──► decideRetry ──► retry_at = now + backoff | fallback now | parked
 *   every tick ──► runDeliveryRetries: claim due rows (FOR UPDATE SKIP LOCKED, so
 *        two orchestrators never resend the same row), resend, link the new attempt.
 *
 * Circuit breaker for ACCOUNT-scope failures (e.g. 131042 billing): while the most
 * recent outcome on our sender is an account failure, the retrier is half-open and
 * sends ONE probe at a time, never a burst into a broken account. The first
 * delivered/read closes it again.
 *
 * Every onboarding send in the product goes through deliverCode / deliverApproval,
 * so nothing can be "sent" without being tracked.
 *
 * ONE clock: every timestamp here is the DATABASE clock (as for pairing codes).
 * Row defaults use now(); computed times start from dbNow(). Host/container skew
 * can therefore never reorder outcomes, revive a retry early or hide the breaker.
 * Callers may pass `now` explicitly (tests travel in time from a dbNow() base).
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import { issuePairingCode } from './pairing.js';
import { WaError } from '../whatsapp/wa-client.js';
import {
  classifyFailure,
  decideRetry,
  isDeliveryStatus,
  mergeStatus,
  type DeliveryStatus,
} from './delivery-policy.js';

export const PAIRING_TEMPLATE = 'pairing_code';
/** WhatsApp template that tells an applicant their pilot application was approved. */
export const APPROVED_TEMPLATE = 'account_approved';

export type OnboardingKind = 'approval_notice' | 'approval_code' | 'admin_code' | 'signup_code';

/** A send returns Meta's message id (wamid) when the client exposes it. */
export interface OnboardingSender {
  sendAuthCode(to: string, template: string, code: string): Promise<string | void>;
  sendTemplate(to: string, template: string, params: string[]): Promise<string | void>;
}

/** The database's clock: the single time source for delivery state. */
export async function dbNow(db: Db): Promise<Date> {
  const [r] = await db.execute<{ now: string | Date }>(sql`select now() as now`);
  return new Date(r!.now);
}

const errCode = (err: unknown): number | undefined => (err instanceof WaError ? err.metaCode : undefined);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Record a send Meta ACCEPTED. Its fate arrives later on the status webhook. */
export async function recordAccepted(
  db: Db,
  row: { tenantId: string; to: string; kind: OnboardingKind; waMessageId: string | void; attempt: number },
): Promise<void> {
  await db
    .insert(schema.onboardingMessages)
    .values({
      tenantId: row.tenantId,
      toE164: row.to,
      kind: row.kind,
      waMessageId: row.waMessageId || null,
      attempt: row.attempt,
    })
    .onConflictDoNothing();
}

/** Record a send Meta REFUSED synchronously, scheduling the policy's retry. */
async function recordRefused(
  db: Db,
  row: { tenantId: string; to: string; kind: OnboardingKind; attempt: number; code: number | undefined; title: string },
  opts: { schedule: boolean; now?: Date },
): Promise<void> {
  const now = opts.now ?? (await dbNow(db));
  const d = decideRetry({ code: row.code, attempt: row.attempt, kind: row.kind, jitterKey: `${row.tenantId}:${row.kind}:${row.attempt}` });
  const retryAt = !opts.schedule ? null : d.kind === 'retry' ? new Date(now.getTime() + d.delayMs) : null;
  await db.insert(schema.onboardingMessages).values({
    tenantId: row.tenantId,
    toE164: row.to,
    kind: row.kind,
    status: 'failed',
    errorCode: row.code ?? null,
    errorTitle: row.title.slice(0, 200),
    attempt: row.attempt,
    retryAt,
  });
  await failureEvent(db, { tenantId: row.tenantId, kind: row.kind, code: row.code, to: row.to, decision: retryAt ? 'retry' : d.kind, when: 'sync' });
}

function failureEvent(
  db: Db,
  e: { tenantId: string; kind: OnboardingKind; code: number | undefined | null; to: string; decision: string; when: 'sync' | 'async' },
) {
  return db.insert(schema.adminEvents).values({
    actor: 'whatsapp',
    action: 'onboarding.delivery_failed',
    detail: {
      tenant_id: e.tenantId,
      kind: e.kind,
      code: e.code ?? null,
      scope: classifyFailure(e.code),
      decision: e.decision,
      reported: e.when,
      phone_tail: e.to.slice(-4),
    },
  });
}

export interface CodeDelivery {
  code: string;
  sent: boolean;
  error?: string;
  errorCode?: number;
}

/**
 * Issue a fresh number-bound code and send it, tracked. On a synchronous refusal
 * the code is marked undelivered (never counts against signup limits) and, unless
 * `burnOnFailure`, stays usable so the operator can read it out.
 */
export async function deliverCode(
  db: Db,
  sender: OnboardingSender,
  a: { tenantId: string; phone: string; kind: Exclude<OnboardingKind, 'approval_notice'>; attempt?: number; burnOnFailure?: boolean; scheduleRetry?: boolean },
): Promise<CodeDelivery> {
  const attempt = a.attempt ?? 1;
  const code = await issuePairingCode(db, a.tenantId, { phoneE164: a.phone, digits: 6 });
  try {
    const id = await sender.sendAuthCode(a.phone, PAIRING_TEMPLATE, code);
    await recordAccepted(db, { tenantId: a.tenantId, to: a.phone, kind: a.kind, waMessageId: id, attempt });
    return { code, sent: true };
  } catch (err) {
    await db
      .update(schema.pairingCodes)
      .set(a.burnOnFailure ? { sendFailedAt: sql`now()`, expiresAt: sql`now()` } : { sendFailedAt: sql`now()` })
      .where(eq(schema.pairingCodes.code, code));
    const metaCode = errCode(err);
    await recordRefused(
      db,
      { tenantId: a.tenantId, to: a.phone, kind: a.kind, attempt, code: metaCode, title: errText(err) },
      { schedule: a.scheduleRetry ?? true },
    );
    return { code, sent: false, error: errText(err), ...(metaCode !== undefined ? { errorCode: metaCode } : {}) };
  }
}

export interface ApprovalDelivery {
  via: 'notice' | 'code';
  sent: boolean;
  code?: string;
  noticeError?: string;
  error?: string;
}

/**
 * Tell an approved applicant. The approval notice invites a reply (any reply from
 * that number pairs it); if Meta refuses it, a verification code goes instead.
 */
export async function deliverApproval(
  db: Db,
  sender: OnboardingSender,
  a: { tenantId: string; phone: string; businessName: string; attempt?: number },
): Promise<ApprovalDelivery> {
  const attempt = a.attempt ?? 1;
  try {
    const id = await sender.sendTemplate(a.phone, APPROVED_TEMPLATE, [a.businessName]);
    await recordAccepted(db, { tenantId: a.tenantId, to: a.phone, kind: 'approval_notice', waMessageId: id, attempt });
    return { via: 'notice', sent: true };
  } catch (noticeErr) {
    // the code below is the retry for this refusal, so the notice row is not scheduled
    await recordRefused(
      db,
      { tenantId: a.tenantId, to: a.phone, kind: 'approval_notice', attempt, code: errCode(noticeErr), title: errText(noticeErr) },
      { schedule: false },
    );
    const r = await deliverCode(db, sender, { tenantId: a.tenantId, phone: a.phone, kind: 'approval_code', attempt });
    return { via: 'code', ...r, noticeError: errText(noticeErr) };
  }
}

/**
 * Fold one Meta status report into its row (idempotent, order-independent).
 * Returns the merged status, or null when the message is not an onboarding one.
 */
export async function applyDeliveryStatus(
  db: Db,
  st: { waMessageId: string; status: string; errors: { code: number; title?: string }[] },
  at?: Date,
): Promise<DeliveryStatus | null> {
  if (!isDeliveryStatus(st.status)) return null;
  const incoming = st.status;
  const now = at ?? (await dbNow(db));
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.onboardingMessages)
      .where(eq(schema.onboardingMessages.waMessageId, st.waMessageId))
      .for('update');
    if (!row) return null;
    const merged = mergeStatus(row.status, incoming);
    if (merged === row.status) return { merged, failedNow: false, row };

    const set: Partial<typeof schema.onboardingMessages.$inferInsert> = { status: merged, updatedAt: now };
    let failedNow = false;
    if (merged === 'failed') {
      failedNow = true;
      const code = st.errors[0]?.code;
      const d = decideRetry({ code, attempt: row.attempt, kind: row.kind, jitterKey: st.waMessageId });
      set.errorCode = code ?? null;
      set.errorTitle = st.errors[0]?.title?.slice(0, 200) ?? null;
      set.retryAt = d.kind === 'retry' ? new Date(now.getTime() + d.delayMs) : d.kind === 'fallback' ? now : null;
    } else if (row.status === 'failed') {
      // a receipt after a failure report: it DID arrive, so cancel the retry
      set.retryAt = null;
    }
    await tx.update(schema.onboardingMessages).set(set).where(eq(schema.onboardingMessages.id, row.id));
    return { merged, failedNow, row, retryAt: set.retryAt ?? null };
  });
  if (!result) return null;
  if (result.failedNow) {
    await failureEvent(db, {
      tenantId: result.row.tenantId,
      kind: result.row.kind,
      code: st.errors[0]?.code,
      to: result.row.toE164,
      decision: result.retryAt ? 'retry' : 'parked',
      when: 'async',
    });
  }
  return result.merged;
}

/**
 * Is our sender account degraded? = the most recent OUTCOME (failed / delivered /
 * read) of any onboarding message is an account-scope failure.
 */
export async function senderDegraded(db: Db): Promise<boolean> {
  const [last] = await db
    .select({ status: schema.onboardingMessages.status, code: schema.onboardingMessages.errorCode })
    .from(schema.onboardingMessages)
    .where(inArray(schema.onboardingMessages.status, ['failed', 'delivered', 'read']))
    .orderBy(desc(schema.onboardingMessages.updatedAt), desc(schema.onboardingMessages.id))
    .limit(1);
  return last?.status === 'failed' && classifyFailure(last.code) === 'account';
}

export interface RetryResult {
  resent: number;
  skipped: number;
  probing: boolean;
}

const PROBE_WINDOW_MINUTES = 10;

/**
 * One retrier tick. Rows due for a retry are claimed (superseded) in a short
 * transaction, then resent outside it. A business that paired meanwhile is skipped.
 */
export async function runDeliveryRetries(
  db: Db,
  sender: OnboardingSender,
  opts: { now?: Date; batch?: number } = {},
): Promise<RetryResult> {
  const now = opts.now ?? (await dbNow(db));
  const result: RetryResult = { resent: 0, skipped: 0, probing: false };

  let batch = opts.batch ?? 10;
  if (await senderDegraded(db)) {
    result.probing = true;
    // half-open: one probe at a time; wait while a recent probe has no outcome yet
    const [inFlight] = await db
      .select({ id: schema.onboardingMessages.id })
      .from(schema.onboardingMessages)
      .where(
        and(
          inArray(schema.onboardingMessages.status, ['accepted', 'sent']),
          isNull(schema.onboardingMessages.supersededAt),
          // DB clock: a probe that never reports back stops blocking after the window
          sql`${schema.onboardingMessages.createdAt} > now() - make_interval(mins => ${PROBE_WINDOW_MINUTES})`,
          gt(schema.onboardingMessages.attempt, 1),
        ),
      )
      .limit(1);
    if (inFlight) return result;
    batch = 1;
  }

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.onboardingMessages.id,
        tenantId: schema.onboardingMessages.tenantId,
        to: schema.onboardingMessages.toE164,
        kind: schema.onboardingMessages.kind,
        attempt: schema.onboardingMessages.attempt,
        errorCode: schema.onboardingMessages.errorCode,
      })
      .from(schema.onboardingMessages)
      .where(
        and(
          isNotNull(schema.onboardingMessages.retryAt),
          lte(schema.onboardingMessages.retryAt, now),
          isNull(schema.onboardingMessages.supersededAt),
        ),
      )
      .orderBy(asc(schema.onboardingMessages.retryAt), asc(schema.onboardingMessages.id))
      .limit(batch)
      .for('update', { skipLocked: true });
    if (rows.length) {
      await tx
        .update(schema.onboardingMessages)
        .set({ supersededAt: now, retryAt: null }) // updated_at = last STATUS change only
        .where(inArray(schema.onboardingMessages.id, rows.map((r) => r.id)));
    }
    return rows;
  });

  for (const row of claimed) {
    const [t] = await db
      .select({ status: schema.tenants.status, name: schema.tenants.businessName, review: schema.tenants.reviewStatus })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, row.tenantId));
    // paired / suspended / declined since: nothing left to deliver
    if (!t || t.status !== 'pending' || t.review === 'awaiting' || t.review === 'declined') {
      result.skipped += 1;
      continue;
    }
    // a newer attempt for this business already exists (e.g. the admin pressed Retry)
    const [newer] = await db
      .select({ id: schema.onboardingMessages.id })
      .from(schema.onboardingMessages)
      .where(
        and(
          eq(schema.onboardingMessages.tenantId, row.tenantId),
          isNull(schema.onboardingMessages.supersededAt),
          gt(schema.onboardingMessages.id, row.id),
        ),
      )
      .limit(1);
    if (newer) {
      result.skipped += 1;
      continue;
    }
    const attempt = row.attempt + 1;
    const fallback = row.kind === 'approval_notice' && classifyFailure(row.errorCode) === 'template';
    if (row.kind === 'approval_notice' && !fallback) {
      await deliverApproval(db, sender, { tenantId: row.tenantId, phone: row.to, businessName: t.name, attempt });
    } else {
      const kind = row.kind === 'approval_notice' ? 'approval_code' : row.kind;
      await deliverCode(db, sender, { tenantId: row.tenantId, phone: row.to, kind, attempt, burnOnFailure: kind === 'signup_code' });
    }
    result.resent += 1;
  }
  return result;
}

/**
 * Operator "Retry now": supersede whatever is pending for this business and send
 * again immediately (approval notice for an approved application, else a code).
 */
export async function retryNow(
  db: Db,
  sender: OnboardingSender,
  t: { id: string; businessName: string; reviewStatus: string | null; phone: string },
): Promise<ApprovalDelivery> {
  const [last] = await db
    .select({ attempt: schema.onboardingMessages.attempt })
    .from(schema.onboardingMessages)
    .where(eq(schema.onboardingMessages.tenantId, t.id))
    .orderBy(desc(schema.onboardingMessages.id))
    .limit(1);
  await db
    .update(schema.onboardingMessages)
    .set({ supersededAt: sql`now()`, retryAt: null })
    .where(and(eq(schema.onboardingMessages.tenantId, t.id), isNull(schema.onboardingMessages.supersededAt)));
  const attempt = (last?.attempt ?? 0) + 1;
  if (t.reviewStatus === 'approved') {
    return deliverApproval(db, sender, { tenantId: t.id, phone: t.phone, businessName: t.businessName, attempt });
  }
  const r = await deliverCode(db, sender, { tenantId: t.id, phone: t.phone, kind: 'admin_code', attempt });
  return { via: 'code', ...r };
}

/** Latest onboarding message per business, for the admin list (one query). */
export async function latestDeliveries(db: Db, tenantIds: string[]) {
  if (tenantIds.length === 0) return new Map<string, typeof schema.onboardingMessages.$inferSelect>();
  const rows = await db
    .selectDistinctOn([schema.onboardingMessages.tenantId])
    .from(schema.onboardingMessages)
    .where(inArray(schema.onboardingMessages.tenantId, tenantIds))
    .orderBy(schema.onboardingMessages.tenantId, desc(schema.onboardingMessages.id));
  return new Map(rows.map((r) => [r.tenantId, r]));
}

/** Run the retrier every `intervalMs`; errors are reported, never swallowed. */
export function startDeliveryRetrier(
  db: Db,
  sender: OnboardingSender,
  log: (msg: string, fields?: Record<string, unknown>) => void,
  intervalMs = 30_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDeliveryRetries(db, sender)
      .then((r) => {
        if (r.resent || r.skipped) log('onboarding retries ran', { ...r });
      })
      .catch((err) => log('onboarding retrier failed', { error: String(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
