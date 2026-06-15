/**
 * Subscription settlement (P10, PRD v2.0 §2): turning a completed Khalti payment
 * into an extended subscription period. Mirrors settlePayment (collections) but
 * advances the SUBSCRIPTION instead of creating a gateway sale.
 *
 * Exactly-once: billing_payments.pidx is UNIQUE and we only advance the period when
 * a payment row flips initiated→completed (the period_end on the payment row is the
 * latch). A replayed callback / double verify finds it already completed and no-ops.
 *
 * Period math + lifecycle transitions are the pure @hisab/shared/billing module.
 */
import { and, eq } from 'drizzle-orm';
import { appendAudit, schema, type Tx } from '@hisab/db';
import { renew, startTrial, type SubscriptionState } from '@hisab/shared';
import type { KhaltiClient } from './khalti.js';
import { getPlan, rupees } from './plans.js';

const { subscriptions, billingPayments } = schema;

const auditB = (tx: Tx, tenantId: string, action: string, detail: Record<string, unknown>) =>
  appendAudit(tx, tenantId, { actor: 'system', action, detail });

const todayIso = (now = new Date()): string => now.toISOString().slice(0, 10);

/** Read the tenant's single subscription row (or null), within the caller's tx. */
export async function loadSubscription(tx: Tx, tenantId: string) {
  const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
  return row ?? null;
}

/** Upsert the subscription to a new lifecycle state (one row per tenant). */
async function writeSubscription(
  tx: Tx,
  tenantId: string,
  planCode: string,
  state: SubscriptionState,
): Promise<void> {
  await tx
    .insert(subscriptions)
    .values({
      tenantId,
      planCode,
      status: state.status,
      currentPeriodEnd: state.currentPeriodEnd,
    })
    .onConflictDoUpdate({
      target: subscriptions.tenantId,
      set: {
        planCode,
        status: state.status,
        currentPeriodEnd: state.currentPeriodEnd,
        updatedAt: new Date(),
      },
    });
}

/** Start (or no-op return) a free trial for the tenant. Idempotent. */
export async function ensureTrial(tx: Tx, tenantId: string, planCode: string, now = new Date()) {
  const existing = await loadSubscription(tx, tenantId);
  if (existing) {
    return { created: false as const, status: existing.status, current_period_end: existing.currentPeriodEnd, plan: existing.planCode };
  }
  const state = startTrial(todayIso(now));
  await writeSubscription(tx, tenantId, planCode, state);
  await auditB(tx, tenantId, 'subscription.trial_started', { plan: planCode, period_end: state.currentPeriodEnd });
  return { created: true as const, status: state.status, current_period_end: state.currentPeriodEnd, plan: planCode };
}

/**
 * Settle a subscription billing payment by pidx: Khalti lookup → amount reconcile →
 * (idempotently) mark completed + extend the subscription period. Returns a receipt
 * on success. Runs in the caller's tx (tenant-scoped tool, or hisab_orch callback).
 */
export async function settleSubscriptionPayment(
  deps: { khalti: KhaltiClient },
  tx: Tx,
  row: typeof billingPayments.$inferSelect,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const lookup = await deps.khalti.lookupPayment(row.pidx);

  // 1. amount must match what we initiated (never trust the gateway's redirect).
  if (BigInt(lookup.total_amount) !== row.amountPaisa) {
    await tx.update(billingPayments).set({ status: 'amount_mismatch', updatedAt: new Date() }).where(eq(billingPayments.id, row.id));
    await auditB(tx, row.tenantId, 'subscription.amount_mismatch', {
      pidx: row.pidx,
      initiated_paisa: Number(row.amountPaisa),
      lookup_paisa: lookup.total_amount,
    });
    return { ok: false, pidx: row.pidx, status: 'amount_mismatch', reason: `gateway reports ${lookup.total_amount} paisa, ${Number(row.amountPaisa)} was initiated — NOT credited` };
  }

  // 2. only a lookup-confirmed Completed extends the period; already-completed no-ops.
  if (lookup.status === 'Completed') {
    if (row.status === 'completed' && row.periodEnd) {
      return { ok: true, pidx: row.pidx, status: 'completed', already_credited: true, plan: row.planCode, current_period_end: row.periodEnd };
    }
    const sub = await loadSubscription(tx, row.tenantId);
    const prior: SubscriptionState = sub
      ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd }
      : { status: 'trial', currentPeriodEnd: todayIso(now) }; // pay-before-trial edge: renew from today
    const next = renew(prior, todayIso(now));

    await writeSubscription(tx, row.tenantId, row.planCode, next);
    await tx
      .update(billingPayments)
      .set({
        status: 'completed',
        transactionId: lookup.transaction_id,
        periodStart: todayIso(now),
        periodEnd: next.currentPeriodEnd,
        updatedAt: new Date(),
      })
      .where(and(eq(billingPayments.id, row.id), eq(billingPayments.status, 'initiated')));
    await auditB(tx, row.tenantId, 'subscription.payment_completed', {
      pidx: row.pidx,
      plan: row.planCode,
      amount_paisa: Number(row.amountPaisa),
      transaction_id: lookup.transaction_id,
      period_end: next.currentPeriodEnd,
    });
    const plan = getPlan(row.planCode);
    return {
      ok: true,
      pidx: row.pidx,
      status: 'completed',
      plan: row.planCode,
      current_period_end: next.currentPeriodEnd,
      receipt: {
        description: `HisabKitab ${plan?.name ?? row.planCode} subscription — 1 month`,
        amount_paisa: Number(row.amountPaisa),
        amount_display: rupees(Number(row.amountPaisa)),
        transaction_id: lookup.transaction_id,
        period_start: todayIso(now),
        period_end: next.currentPeriodEnd,
      },
    };
  }

  // 3. terminal non-success updates the row; in-flight states change nothing.
  const terminal =
    lookup.status === 'Expired' ? 'expired' : lookup.status === 'User canceled' ? 'canceled' : null;
  if (terminal && row.status === 'initiated') {
    await tx.update(billingPayments).set({ status: terminal, updatedAt: new Date() }).where(eq(billingPayments.id, row.id));
  }
  return { ok: false, pidx: row.pidx, status: terminal ?? row.status, gateway_status: lookup.status, reason: 'subscription payment not completed' };
}
