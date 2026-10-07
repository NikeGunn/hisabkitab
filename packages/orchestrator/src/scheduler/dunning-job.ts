/**
 * Subscription dunning pass (P10, PRD v2.0 §2): renewal nudges + auto-suspend.
 *
 * For every subscription, as of `now`:
 *   - compute the lifecycle decision (pure @hisab/shared/billing dunningDecision):
 *       renewal_due_soon  → "your plan renews on …; reply renew"
 *       expired (past_due)→ "your plan ended; you still have a few days"
 *       suspended         → "your plan is paused; data retained; reply renew"
 *   - advance subscriptions.status to the projected status (past_due/suspended), and
 *   - send the matching Utility template ONCE.
 *
 * Exactly-once, like the reminder pass: the latch lives in the DB, not the queue.
 * subscriptions.(last_dunned_stage, last_dunned_for) records the last nudge sent.
 * A daily pass that finds the same (stage, period_end) already latched sends nothing,
 * so retries / multiple replicas / a manual trigger never double-send or double-suspend.
 * Never deletes data on non-payment (suspend + retain).
 */
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import { dunningDecision, getPlanName, type DunningStage } from './dunning-support.js';

const { subscriptions, tenants } = schema;

/** Send a pre-approved billing Utility template to a tenant's WhatsApp number. */
export type BillingTemplateSender = (
  toE164: string,
  templateName: 'subscription_due_soon' | 'plan_ended_notice' | 'plan_paused_notice',
  bodyParams: string[],
) => Promise<void>;

export interface DunningJobDeps {
  /** hisab_orch handle (cross-tenant; the orch_all policy on subscriptions). */
  db: Db;
  sendTemplate: BillingTemplateSender;
  log?: (msg: string) => void;
}

export interface TenantDunningOutcome {
  tenantId: string;
  status: 'sent' | 'skipped' | 'no_number' | 'error';
  stage?: DunningStage;
  newStatus?: string;
  detail?: string;
}

const TEMPLATE_FOR: Record<DunningStage, 'subscription_due_soon' | 'plan_ended_notice' | 'plan_paused_notice'> = {
  renewal_due_soon: 'subscription_due_soon',
  expired: 'plan_ended_notice',
  suspended: 'plan_paused_notice',
};

/** Format an ISO date as "30 Asar"-ish display is overkill here; keep the ISO end date. */
function dueDisplay(iso: string): string {
  return iso;
}

export async function runDunningPass(deps: DunningJobDeps, now: Date): Promise<TenantDunningOutcome[]> {
  const today = now.toISOString().slice(0, 10);
  const rows = await deps.db
    .select({
      tenantId: subscriptions.tenantId,
      planCode: subscriptions.planCode,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      lastStage: subscriptions.lastDunnedStage,
      lastFor: subscriptions.lastDunnedFor,
      e164: tenants.whatsappE164,
    })
    .from(subscriptions)
    .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId));

  const outcomes: TenantDunningOutcome[] = [];
  for (const row of rows) {
    try {
      const decision = dunningDecision({ status: row.status, currentPeriodEnd: row.currentPeriodEnd }, today);

      // Always reconcile the stored status to the time-aware projection (even when
      // there's no nudge to send — e.g. a lapse crossed into suspended overnight).
      if (decision.status !== row.status) {
        await deps.db
          .update(subscriptions)
          .set({ status: decision.status, updatedAt: new Date() })
          .where(eq(subscriptions.tenantId, row.tenantId));
      }

      if (!decision.stage) {
        outcomes.push({ tenantId: row.tenantId, status: 'skipped', newStatus: decision.status });
        continue;
      }

      // Latch: same (stage, period_end) already nudged → send nothing.
      if (row.lastStage === decision.stage && row.lastFor === decision.forPeriodEnd) {
        outcomes.push({ tenantId: row.tenantId, status: 'skipped', stage: decision.stage, detail: 'already dunned' });
        continue;
      }

      if (!row.e164) {
        outcomes.push({ tenantId: row.tenantId, status: 'no_number', stage: decision.stage });
        continue;
      }

      const planName = getPlanName(row.planCode);
      const params =
        decision.stage === 'renewal_due_soon'
          ? [planName, dueDisplay(row.currentPeriodEnd), planPriceDisplay(row.planCode)]
          : [planName];
      await deps.sendTemplate(row.e164, TEMPLATE_FOR[decision.stage], params);

      // Record the latch + the advanced status together.
      await deps.db
        .update(subscriptions)
        .set({
          status: decision.status,
          lastDunnedStage: decision.stage,
          lastDunnedFor: decision.forPeriodEnd,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.tenantId, row.tenantId));

      outcomes.push({ tenantId: row.tenantId, status: 'sent', stage: decision.stage, newStatus: decision.status });
    } catch (err) {
      outcomes.push({ tenantId: row.tenantId, status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  deps.log?.(`dunning pass: ${outcomes.length} subscriptions scanned`);
  return outcomes;
}

// Price display is derived in dunning-support to avoid importing the payments
// package (cross-package); it mirrors plans.ts. Re-exported for the param above.
import { planPriceDisplay } from './dunning-support.js';
