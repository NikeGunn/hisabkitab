/**
 * Per-tenant monthly cost budgets (PRD v2.0 §7 — "per-tenant budgets: monthly
 * token cap per plan; soft-warn then throttle"). PURE, no IO.
 *
 * Protects unit economics (the ~Rs 3,000 margin per Starter seat). Each plan has
 * a monthly COST cap in integer paisa (CLAUDE.md §3 — money is always paisa). As a
 * tenant's accumulated estimated model cost climbs, the verdict walks:
 *
 *   spend < 80% of cap   → OK        (full service)
 *   80% ≤ spend < 100%   → WARN      (serve, but nudge the owner once)
 *   spend ≥ 100% of cap  → THROTTLE  (stop starting new agent turns this period)
 *
 * THROTTLE is backpressure, never data loss: the owner is told to retry next
 * period / upgrade; nothing they already sent is dropped silently. A 10× anomaly
 * (sudden spike) is surfaced so ops can investigate abuse.
 *
 * Cost is ESTIMATED from token counts via per-model rates (estimateCostPaisa);
 * the estimate is intentionally conservative (rounds up) so we throttle slightly
 * early rather than blow the budget.
 */
import type { PlanCode } from '../billing/features.js';

export type BudgetVerdict = 'OK' | 'WARN' | 'THROTTLE';

/** Monthly model-cost cap per plan, integer paisa. Config in ONE place. */
export const PLAN_BUDGET_PAISA: Record<PlanCode, number> = {
  starter: 50_000, // Rs 500 / mo of model spend
  pro: 120_000, // Rs 1,200
  business: 300_000, // Rs 3,000
};

/** Soft-warn threshold (fraction of cap) before hard throttle. */
export const WARN_FRACTION = 0.8;

/** A tenant spending ≥ this multiple of its plan's *typical* daily share is an
 *  anomaly worth alerting on (sudden 10× usage → possible abuse). */
export const ANOMALY_MULTIPLE = 10;

/** Accumulated usage for a tenant in the current period. */
export interface UsageSnapshot {
  /** total estimated model cost so far this period, integer paisa. */
  costPaisa: number;
  /** total agent turns this period (for anomaly heuristics). */
  turns: number;
}

export interface BudgetProjection {
  verdict: BudgetVerdict;
  /** the plan's monthly cap (paisa). */
  capPaisa: number;
  /** spend so far (paisa). */
  spentPaisa: number;
  /** remaining headroom (paisa), floored at 0. */
  remainingPaisa: number;
  /** fraction of cap used, 0..(>1). */
  fractionUsed: number;
}

function capFor(plan: string): number {
  return (PLAN_BUDGET_PAISA as Record<string, number>)[plan] ?? PLAN_BUDGET_PAISA.starter;
}

/**
 * Project the budget verdict for a plan + usage snapshot. Unknown plan falls back
 * to the strictest (starter) cap — deny-by-default for cost, mirroring RBAC.
 */
export function projectBudget(plan: string, usage: UsageSnapshot): BudgetProjection {
  const capPaisa = capFor(plan);
  const spentPaisa = Math.max(0, Math.floor(usage.costPaisa));
  const fractionUsed = capPaisa > 0 ? spentPaisa / capPaisa : Infinity;
  let verdict: BudgetVerdict = 'OK';
  if (spentPaisa >= capPaisa) verdict = 'THROTTLE';
  else if (fractionUsed >= WARN_FRACTION) verdict = 'WARN';
  return {
    verdict,
    capPaisa,
    spentPaisa,
    remainingPaisa: Math.max(0, capPaisa - spentPaisa),
    fractionUsed,
  };
}

/**
 * Per-model token pricing in paisa-per-million-tokens (input, output). Approximate,
 * config in ONE place; tuned so the estimate rounds UP (throttle slightly early).
 * Rates are illustrative USD→NPR-ish; refine with real invoices at scale.
 */
export const MODEL_RATES_PAISA_PER_MTOK: Record<string, { input: number; output: number }> = {
  // money/extraction tier (Opus-class)
  'claude-opus-4-8': { input: 200_000, output: 1_000_000 },
  // cheap tier (Sonnet-class)
  'claude-sonnet-4-6': { input: 40_000, output: 200_000 },
  // trivial tier (Haiku-class) — used if trivial turns ever reach a model
  'claude-haiku-4-5-20251001': { input: 10_000, output: 50_000 },
};

const DEFAULT_RATE = { input: 200_000, output: 1_000_000 }; // unknown model → most expensive (conservative)

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Estimate the paisa cost of a turn's token usage on a given model. Rounds UP
 * (Math.ceil) so we never under-count and over-spend. Unknown model uses the
 * most-expensive rate so a misconfigured model can't sneak past the budget.
 */
export function estimateCostPaisa(model: string, usage: TokenUsage): number {
  const rate = MODEL_RATES_PAISA_PER_MTOK[model] ?? DEFAULT_RATE;
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const paisa = (input * rate.input + output * rate.output) / 1_000_000;
  return Math.ceil(paisa);
}

/** Friendly reply when a tenant has hit its monthly budget cap (never silent). */
export const BUDGET_THROTTLED_REPLY =
  '🙏 You have reached this month\'s usage limit on your current plan. Your data is safe and ' +
  'nothing is lost. It resets next month — or reply "upgrade" for a higher plan to continue now.';

/** One-line warning appended when a tenant crosses the soft-warn threshold. */
export const BUDGET_WARN_NOTE =
  '\n\n(Heads up: you are close to this month\'s usage limit on your plan.)';
