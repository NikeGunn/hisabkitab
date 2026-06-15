/**
 * Payments MCP tools (PRD v1.1 §10). Khalti v2 is live; eSewa/Fonepay return a
 * friendly "coming soon". Non-negotiables enforced here, not in the prompt:
 *   - NO money action without `owner_approved: true` for that specific action
 *     (zod literal — a call without the owner's explicit ✅ cannot parse).
 *   - The Khalti LOOKUP is the only source of truth — callback params and
 *     model-claimed statuses are never trusted.
 *   - Amount reconciliation: lookup.total_amount must equal the initiated
 *     amount or the payment is flagged `amount_mismatch` and NEVER completed.
 *   - Exactly-once: pidx is unique; the confirmed gateway sale is created at
 *     most once (payments.sale_id is the latch) inside one tenant transaction.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { schema, withTenant, type Db, type Tx } from '@hisab/db';
import { defaultTaxConfig, splitVatInclusive, type TaxConfig, type Capability, type Role } from '@hisab/shared';
import type { KhaltiClient, KhaltiLookupResponse } from './khalti.js';
import { SUBSCRIPTION_PLANS, getPlan, rupees } from './plans.js';
import { ensureTrial, loadSubscription, settleSubscriptionPayment } from './billing.js';
import { projectStatus, hasAccess, type SubscriptionState } from '@hisab/shared';

const { payments, sales, auditLog, billingPayments, subscriptions: subscriptionsTable } = schema;

const paisa = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('integer paisa (1 NPR = 100 paisa)');

/** The consent gate: unparseable without the owner's explicit ✅ for THIS action. */
const ownerApproved = z
  .literal(true)
  .describe(
    'set to true ONLY after the owner sent an explicit "✅"/"yes" for THIS specific ' +
      'payment action in this conversation — never inferred, never carried over',
  );

export const inputSchemas = {
  initiate_payment: {
    amount_paisa: paisa,
    purpose: z.string().min(1).max(200).describe('what the customer is paying for'),
    customer_name: z.string().max(100).optional(),
    owner_approved: ownerApproved,
  },
  verify_payment: {
    pidx: z.string().min(1).max(100),
  },
  refund_payment: {
    pidx: z.string().min(1).max(100),
    owner_approved: ownerApproved,
  },
  list_collected_payments: {
    status: z
      .enum(['initiated', 'completed', 'canceled', 'expired', 'refunded', 'amount_mismatch'])
      .optional(),
  },
  esewa_initiate_payment: { amount_paisa: paisa.optional() },
  fonepay_initiate_payment: { amount_paisa: paisa.optional() },
  // ---- subscription billing (v2.0 P10): the SMB pays HisabKitab ----
  list_subscription_plans: {},
  start_trial: {
    plan_code: z.enum(['starter', 'pro', 'business']).default('pro').describe('tier the trial previews'),
  },
  get_subscription_status: {},
  initiate_subscription: {
    plan_code: z.enum(['starter', 'pro', 'business']).describe('which subscription tier the owner chose'),
    owner_approved: ownerApproved,
  },
  verify_subscription: {
    pidx: z.string().min(1).max(100),
  },
  cancel_subscription: {
    owner_approved: ownerApproved,
  },
} as const;

/**
 * RBAC map (PRD v2.0 §3): payment money actions are OWNER-ONLY (`move_money`);
 * subscription/billing management is owner-only (`manage_billing`); read-only
 * listings need only `generate_report`. Enforced in server.ts before the handler.
 * `Record<keyof inputSchemas, …>` forces every new tool to declare a capability.
 */
export const TOOL_CAPABILITY: Record<keyof typeof inputSchemas, Capability> = {
  initiate_payment: 'move_money',
  refund_payment: 'move_money',
  esewa_initiate_payment: 'move_money',
  fonepay_initiate_payment: 'move_money',
  verify_payment: 'move_money',
  initiate_subscription: 'manage_billing',
  verify_subscription: 'manage_billing',
  cancel_subscription: 'manage_billing',
  start_trial: 'manage_billing',
  list_collected_payments: 'generate_report',
  list_subscription_plans: 'generate_report',
  get_subscription_status: 'generate_report',
} as const;

export interface PaymentsToolContext {
  db: Db;
  tenantId: string;
  role: Role;
  khalti: KhaltiClient;
  /** Public GET endpoint Khalti redirects the payer back to. */
  returnUrl: string;
  websiteUrl: string;
  cfg?: TaxConfig;
  /**
   * When false/omitted, subscription billing runs in DEV mode: it shows the plan
   * and price but does NOT call Khalti or write a payment (no charge, no API cost).
   * Flip to true only once deployed with a real Khalti merchant key (PAYMENTS_LIVE=1).
   */
  live?: boolean;
}

type Args<K extends keyof typeof inputSchemas> = z.infer<z.ZodObject<(typeof inputSchemas)[K]>>;

const COMING_SOON = (provider: string) =>
  `${provider} is coming soon — for now I can create a Khalti payment link instead.` as const;

const audit = (tx: Tx, tenantId: string, action: string, detail: Record<string, unknown>) =>
  tx.insert(auditLog).values({ tenantId, actor: 'agent', action, detail });

/** Map a Khalti lookup status onto our payment row status (no-op for in-flight states). */
const rowStatusFor = (s: KhaltiLookupResponse['status']) =>
  s === 'Completed'
    ? ('completed' as const)
    : s === 'Refunded' || s === 'Partially Refunded'
      ? ('refunded' as const)
      : s === 'Expired'
        ? ('expired' as const)
        : s === 'User canceled'
          ? ('canceled' as const)
          : null;

/**
 * Shared by the verify_payment tool and the public return-URL callback:
 * lookup → reconcile amount → (idempotently) complete + create the confirmed
 * gateway sale in ONE transaction. Runs under whichever db handle the caller
 * holds (tenant-scoped for the tool, hisab_orch for the callback).
 */
export async function settlePayment(
  deps: { khalti: KhaltiClient; cfg?: TaxConfig },
  tx: Tx,
  row: typeof payments.$inferSelect,
): Promise<Record<string, unknown>> {
  const cfg = deps.cfg ?? defaultTaxConfig;
  const lookup = await deps.khalti.lookupPayment(row.pidx);

  // 1. the gateway's word on the amount must match what WE initiated
  if (BigInt(lookup.total_amount) !== row.amountPaisa) {
    await tx
      .update(payments)
      .set({ status: 'amount_mismatch', updatedAt: new Date() })
      .where(eq(payments.id, row.id));
    await audit(tx, row.tenantId, 'payment.amount_mismatch', {
      pidx: row.pidx,
      initiated_paisa: Number(row.amountPaisa),
      lookup_paisa: lookup.total_amount,
    });
    return {
      ok: false,
      pidx: row.pidx,
      status: 'amount_mismatch',
      reason: `gateway reports ${lookup.total_amount} paisa but ${Number(row.amountPaisa)} paisa was initiated — NOT completed; ask the owner / contact Khalti`,
    };
  }

  // 2. only a lookup-confirmed Completed settles; sale_id is the exactly-once latch
  if (lookup.status === 'Completed') {
    if (row.saleId) {
      return {
        ok: true,
        pidx: row.pidx,
        status: 'completed',
        already_recorded: true,
        sale_id: row.saleId,
        amount_paisa: Number(row.amountPaisa),
      };
    }
    const { exclPaisa, vatPaisa } = splitVatInclusive(row.amountPaisa, cfg);
    const [sale] = await tx
      .insert(sales)
      .values({
        tenantId: row.tenantId,
        occurredOn: new Date().toISOString().slice(0, 10),
        description: `Khalti collection: ${row.purchaseOrderName}`,
        amountExclVatPaisa: exclPaisa,
        vatPaisa,
        paymentMethod: 'khalti',
        source: 'gateway',
        gatewayRef: row.pidx,
        status: 'confirmed', // gateway settlement IS the confirmation (PRD v1.1 §10)
      })
      .returning({ id: sales.id });
    const saleId = sale!.id;
    await tx
      .update(payments)
      .set({
        status: 'completed',
        transactionId: lookup.transaction_id,
        feePaisa: BigInt(lookup.fee),
        saleId,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, row.id), eq(payments.status, 'initiated')));
    await audit(tx, row.tenantId, 'payment.completed', {
      pidx: row.pidx,
      transaction_id: lookup.transaction_id,
      amount_paisa: Number(row.amountPaisa),
      fee_paisa: lookup.fee,
      sale_id: saleId,
    });
    return {
      ok: true,
      pidx: row.pidx,
      status: 'completed',
      sale_id: saleId,
      amount_paisa: Number(row.amountPaisa),
      amount_excl_vat_paisa: Number(exclPaisa),
      vat_paisa: Number(vatPaisa),
      fee_paisa: lookup.fee,
      note: 'recorded as a CONFIRMED gateway sale (VAT-inclusive split)',
    };
  }

  // 3. terminal non-success states update the row; in-flight states change nothing
  const terminal = rowStatusFor(lookup.status);
  if (terminal && terminal !== 'completed' && row.status === 'initiated') {
    await tx
      .update(payments)
      .set({ status: terminal, updatedAt: new Date() })
      .where(eq(payments.id, row.id));
    await audit(tx, row.tenantId, `payment.${terminal}`, { pidx: row.pidx, lookup_status: lookup.status });
  }
  return {
    ok: false,
    pidx: row.pidx,
    status: terminal ?? row.status,
    gateway_status: lookup.status,
    reason:
      lookup.status === 'Pending' || lookup.status === 'Initiated'
        ? 'payment not completed yet — check again shortly'
        : `gateway reports "${lookup.status}" — nothing was recorded`,
  };
}

export function createToolHandlers(ctx: PaymentsToolContext) {
  const inTenantTx = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(ctx.db, ctx.tenantId, fn);

  return {
    async initiate_payment(args: Args<'initiate_payment'>) {
      const orderId = `hisab-${randomUUID()}`;
      const initiated = await ctx.khalti.initiatePayment({
        amountPaisa: BigInt(args.amount_paisa),
        purchaseOrderId: orderId,
        purchaseOrderName: args.purpose,
        returnUrl: ctx.returnUrl,
        websiteUrl: ctx.websiteUrl,
        ...(args.customer_name ? { customerInfo: { name: args.customer_name } } : {}),
      });
      return inTenantTx(async (tx) => {
        await tx.insert(payments).values({
          tenantId: ctx.tenantId,
          provider: 'khalti',
          pidx: initiated.pidx,
          purchaseOrderId: orderId,
          purchaseOrderName: args.purpose,
          amountPaisa: BigInt(args.amount_paisa),
          paymentUrl: initiated.payment_url,
        });
        await audit(tx, ctx.tenantId, 'payment.initiated', {
          pidx: initiated.pidx,
          amount_paisa: args.amount_paisa,
          purpose: args.purpose,
          owner_approved: true,
        });
        return {
          ok: true,
          pidx: initiated.pidx,
          payment_url: initiated.payment_url,
          expires_at: initiated.expires_at,
          amount_paisa: args.amount_paisa,
          note: 'share the payment_url with the customer; the entry is recorded only after the payment completes and is verified',
        };
      });
    },

    // ---- subscription billing (v2.0 P10) ----
    async list_subscription_plans(_args: Args<'list_subscription_plans'>) {
      return {
        currency: 'NPR' as const,
        billing: 'prepaid monthly' as const,
        live: ctx.live === true,
        plans: SUBSCRIPTION_PLANS.map((p) => ({
          code: p.code,
          name: p.name,
          price_paisa: p.pricePaisa,
          price_display: rupees(p.pricePaisa),
          blurb: p.blurb,
          features: p.features,
        })),
      };
    },

    /**
     * Start a subscription payment for the chosen plan. The price comes from the
     * plan config (never the caller), so the amount can't be tampered with. Requires
     * the owner's explicit ✅. In DEV mode (ctx.live !== true) it returns the plan +
     * price WITHOUT calling Khalti or charging — safe until the servers are live.
     */
    async initiate_subscription(args: Args<'initiate_subscription'>) {
      const plan = getPlan(args.plan_code);
      if (!plan) return { ok: false as const, reason: `unknown plan: ${args.plan_code}` };

      if (ctx.live !== true) {
        // Safe/dev mode: no Khalti call, no DB write, no cost. Record the intent only.
        await inTenantTx((tx) =>
          audit(tx, ctx.tenantId, 'subscription.dev_preview', { plan: plan.code, price_paisa: plan.pricePaisa }),
        );
        return {
          ok: true as const,
          mode: 'development' as const,
          plan: plan.code,
          plan_name: plan.name,
          amount_paisa: plan.pricePaisa,
          amount_display: rupees(plan.pricePaisa),
          charged: false as const,
          note: 'Development environment: nothing was charged. Live billing opens once HisabKitab is deployed with a Khalti merchant account.',
        };
      }

      // Live mode: same exactly-once Khalti path as a collection, priced from config.
      const orderId = `hisab-sub-${randomUUID()}`;
      const purpose = `HisabKitab ${plan.name} subscription (1 month)`;
      const initiated = await ctx.khalti.initiatePayment({
        amountPaisa: BigInt(plan.pricePaisa),
        purchaseOrderId: orderId,
        purchaseOrderName: purpose,
        returnUrl: ctx.returnUrl,
        websiteUrl: ctx.websiteUrl,
      });
      return inTenantTx(async (tx) => {
        // Subscription payments live in billing_payments (the tenant paying US),
        // NOT the `payments` table (their customer paying them → a sale).
        await tx.insert(billingPayments).values({
          tenantId: ctx.tenantId,
          planCode: plan.code,
          gateway: 'khalti',
          pidx: initiated.pidx,
          purchaseOrderId: orderId,
          amountPaisa: BigInt(plan.pricePaisa),
          paymentUrl: initiated.payment_url,
        });
        await audit(tx, ctx.tenantId, 'subscription.initiated', {
          pidx: initiated.pidx,
          plan: plan.code,
          amount_paisa: plan.pricePaisa,
          owner_approved: true,
        });
        return {
          ok: true as const,
          mode: 'live' as const,
          plan: plan.code,
          plan_name: plan.name,
          pidx: initiated.pidx,
          payment_url: initiated.payment_url,
          expires_at: initiated.expires_at,
          amount_paisa: plan.pricePaisa,
          amount_display: rupees(plan.pricePaisa),
          charged: false as const,
          note: 'Share/open the payment_url to pay. The subscription activates only after the payment completes and verify_subscription confirms it.',
        };
      });
    },

    async start_trial(args: Args<'start_trial'>) {
      return inTenantTx((tx) => ensureTrial(tx, ctx.tenantId, args.plan_code));
    },

    /** Project the CURRENT lifecycle status from the stored period (not the stale row). */
    async get_subscription_status(_args: Args<'get_subscription_status'>) {
      return inTenantTx(async (tx) => {
        const sub = await loadSubscription(tx, ctx.tenantId);
        if (!sub) return { exists: false as const, note: 'No subscription yet. Start a free trial or choose a plan.' };
        const state: SubscriptionState = { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd };
        const today = new Date().toISOString().slice(0, 10);
        const projected = projectStatus(state, today);
        const plan = getPlan(sub.planCode);
        return {
          exists: true as const,
          plan: sub.planCode,
          plan_name: plan?.name ?? sub.planCode,
          stored_status: sub.status,
          status: projected, // the authoritative, time-aware status
          current_period_end: sub.currentPeriodEnd,
          has_access: hasAccess(state, today),
          note:
            projected === 'past_due'
              ? 'Your subscription has lapsed but you still have access during the grace period. Renew to stay active.'
              : projected === 'suspended'
                ? 'Your subscription is suspended. Your data is safe; pay to reactivate.'
                : undefined,
        };
      });
    },

    async verify_subscription(args: Args<'verify_subscription'>) {
      return inTenantTx(async (tx) => {
        const [row] = await tx.select().from(billingPayments).where(eq(billingPayments.pidx, args.pidx));
        if (!row) return { ok: false as const, reason: 'no such subscription payment in this business' };
        return settleSubscriptionPayment({ khalti: ctx.khalti }, tx, row);
      });
    },

    /** Owner-initiated cancellation. Terminal; access remains until period end (no refund here). */
    async cancel_subscription(_args: Args<'cancel_subscription'>) {
      return inTenantTx(async (tx) => {
        const sub = await loadSubscription(tx, ctx.tenantId);
        if (!sub) return { ok: false as const, reason: 'no subscription to cancel' };
        if (sub.status === 'cancelled') return { ok: true as const, status: 'cancelled' as const, already: true };
        await tx
          .update(subscriptionsTable)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(subscriptionsTable.tenantId, ctx.tenantId));
        await audit(tx, ctx.tenantId, 'subscription.cancelled', { plan: sub.planCode, was: sub.status });
        return {
          ok: true as const,
          status: 'cancelled' as const,
          access_until: sub.currentPeriodEnd,
          note: 'Subscription cancelled. You keep access until the end of the period you already paid for. Your data is retained.',
        };
      });
    },

    async verify_payment(args: Args<'verify_payment'>) {
      return inTenantTx(async (tx) => {
        const [row] = await tx.select().from(payments).where(eq(payments.pidx, args.pidx));
        if (!row) return { ok: false as const, reason: 'no such payment in this business' };
        return settlePayment({ khalti: ctx.khalti, ...(ctx.cfg ? { cfg: ctx.cfg } : {}) }, tx, row);
      });
    },

    async refund_payment(args: Args<'refund_payment'>) {
      return inTenantTx(async (tx) => {
        const [row] = await tx.select().from(payments).where(eq(payments.pidx, args.pidx));
        if (!row) return { ok: false as const, reason: 'no such payment in this business' };
        if (row.status !== 'completed' || !row.transactionId) {
          return { ok: false as const, reason: `only completed payments can be refunded (status: ${row.status})` };
        }
        await ctx.khalti.refundPayment(row.transactionId); // full refund only in v1
        await tx
          .update(payments)
          .set({ status: 'refunded', updatedAt: new Date() })
          .where(eq(payments.id, row.id));
        await audit(tx, ctx.tenantId, 'payment.refunded', {
          pidx: row.pidx,
          transaction_id: row.transactionId,
          amount_paisa: Number(row.amountPaisa),
          owner_approved: true,
        });
        return {
          ok: true as const,
          pidx: row.pidx,
          status: 'refunded' as const,
          note: 'full refund requested at Khalti. The linked sale stays on the books — ask the owner/accountant how to adjust it (credit note vs reversal).',
        };
      });
    },

    async list_collected_payments(args: Args<'list_collected_payments'>) {
      return inTenantTx(async (tx) => {
        const rows = await tx
          .select()
          .from(payments)
          .where(
            args.status
              ? and(eq(payments.tenantId, ctx.tenantId), eq(payments.status, args.status))
              : eq(payments.tenantId, ctx.tenantId),
          )
          .orderBy(desc(payments.createdAt));
        return {
          count: rows.length,
          items: rows.map((r) => ({
            pidx: r.pidx,
            purpose: r.purchaseOrderName,
            amount_paisa: Number(r.amountPaisa),
            status: r.status,
            sale_id: r.saleId,
            created_at: r.createdAt.toISOString(),
          })),
        };
      });
    },

    async esewa_initiate_payment(_args: Args<'esewa_initiate_payment'>) {
      return { ok: false as const, status: 'coming_soon' as const, message: COMING_SOON('eSewa') };
    },

    async fonepay_initiate_payment(_args: Args<'fonepay_initiate_payment'>) {
      return { ok: false as const, status: 'coming_soon' as const, message: COMING_SOON('Fonepay') };
    },
  };
}

export const toolDescriptions: Record<keyof typeof inputSchemas, string> = {
  initiate_payment:
    'Create a Khalti payment link for a customer. REQUIRES the owner\'s explicit "✅"/yes for this specific payment (owner_approved). Returns payment_url to share. Nothing is recorded until the payment completes AND verify_payment confirms it.',
  verify_payment:
    'Server-side Khalti lookup by pidx — the ONLY trusted source of payment status. On Completed: records a CONFIRMED gateway sale exactly once. Flags amount mismatches instead of completing.',
  refund_payment:
    'Full refund of a completed Khalti payment. REQUIRES the owner\'s explicit "✅"/yes for this specific refund (owner_approved).',
  list_collected_payments: 'List this business\'s Khalti payments (newest first), optionally by status.',
  esewa_initiate_payment: 'eSewa is COMING SOON — returns a friendly message to relay; offer Khalti instead.',
  fonepay_initiate_payment: 'Fonepay is COMING SOON — returns a friendly message to relay; offer Khalti instead.',
  list_subscription_plans:
    'List the HisabKitab subscription plans the business can buy (Starter/Pro/Business, prices in NPR, prepaid monthly). Read-only, no charge. Use the EXACT price_display values when telling the owner.',
  initiate_subscription:
    'Start paying for a HisabKitab subscription plan (the business pays US). Price comes from the chosen plan_code, not the caller. REQUIRES the owner\'s explicit "✅"/yes (owner_approved). In development it returns the plan + price WITHOUT charging; once live it returns a Khalti payment_url.',
  start_trial:
    'Begin a free trial for this business (idempotent — returns the existing subscription if one exists). Gives full access for the trial period; no payment needed.',
  get_subscription_status:
    'Report this business\'s subscription: plan, the time-aware status (trial/active/past_due/suspended/cancelled), period end, and whether it still has access. Use this before gating a paid feature.',
  verify_subscription:
    'Server-side Khalti lookup by pidx for a SUBSCRIPTION payment — the only trusted source. On Completed: extends the subscription period exactly once and returns a receipt. Flags amount mismatches.',
  cancel_subscription:
    'Cancel this business\'s subscription at the owner\'s explicit request (owner_approved). Access continues until the paid period ends; data is retained. Terminal until they subscribe again.',
};
