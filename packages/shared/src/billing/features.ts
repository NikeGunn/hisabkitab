/**
 * Plan feature-gating (PRD v2.0 §1) — PURE, no IO. Maps a plan to the features it
 * unlocks so the orchestrator can gate capabilities server-side and surface
 * "upgrade to unlock" prompts. Plan PRICES live in @hisab/mcp-payments/plans.ts
 * (the billing source of truth); this maps the same plan CODES to capabilities.
 */
import type { Role } from '../rbac/roles.js';

export type PlanCode = 'starter' | 'pro' | 'business';

/**
 * Canonical plan metadata (the SINGLE source of truth for code → name + monthly
 * price). `@hisab/mcp-payments/plans.ts` composes its richer Plan objects on top of
 * this, and the orchestrator's dunning reads it — so prices live in exactly one place.
 * Prices are integer paisa (CLAUDE.md §3).
 */
export interface PlanMeta {
  code: PlanCode;
  name: string;
  pricePaisa: number;
}

export const PLAN_META: Record<PlanCode, PlanMeta> = {
  starter: { code: 'starter', name: 'Starter', pricePaisa: 299_900 }, // Rs 2,999
  pro: { code: 'pro', name: 'Pro', pricePaisa: 499_900 }, // Rs 4,999
  business: { code: 'business', name: 'Business', pricePaisa: 799_900 }, // Rs 7,999
};

/** Plan name for a code, or the raw code if unknown. */
export function planName(code: string): string {
  return isPlanCode(code) ? PLAN_META[code].name : code;
}

/** Monthly price (paisa) for a code, or 0 if unknown. */
export function planPricePaisa(code: string): number {
  return isPlanCode(code) ? PLAN_META[code].pricePaisa : 0;
}

/** Gateable capabilities. Add a feature here, then list it under each plan below. */
export type Feature =
  | 'logging' // record sales/expenses (everyone)
  | 'vat_reminders' // monthly VAT return prep + nudge
  | 'arap' // debtors/creditors, statements, aging
  | 'reports' // professional PDF reports
  | 'accountant_seat'; // an accountant membership (record + confirm on the owner's behalf)

/** Cumulative tiers: each plan includes everything cheaper plans have. */
const PLAN_FEATURES: Record<PlanCode, readonly Feature[]> = {
  starter: ['logging', 'vat_reminders'],
  pro: ['logging', 'vat_reminders', 'arap', 'accountant_seat'],
  business: ['logging', 'vat_reminders', 'arap', 'reports', 'accountant_seat'],
};

/** Max members (users) a plan allows, INCLUDING the owner. Starter = the owner alone. */
const PLAN_SEATS: Record<PlanCode, number> = { starter: 1, pro: 3, business: 10 };

function isPlanCode(code: string): code is PlanCode {
  return code === 'starter' || code === 'pro' || code === 'business';
}

/** True if `planCode` unlocks `feature`. Unknown plan → false (deny by default). */
export function planAllows(planCode: string, feature: Feature): boolean {
  if (!isPlanCode(planCode)) return false;
  return PLAN_FEATURES[planCode].includes(feature);
}

/** Seat allowance for a plan; 0 for an unknown plan. */
export function planSeats(planCode: string): number {
  return isPlanCode(planCode) ? PLAN_SEATS[planCode] : 0;
}

/** The cheapest plan that unlocks `feature` (for an upgrade prompt), or null. */
export function minPlanFor(feature: Feature): PlanCode | null {
  for (const code of ['starter', 'pro', 'business'] as const) {
    if (PLAN_FEATURES[code].includes(feature)) return code;
  }
  return null;
}

/**
 * Roles that need a specific plan feature on top of a free seat. Read-only roles
 * (auditor, viewer) and staff only need a seat; an accountant (who can CONFIRM
 * entries) needs the accountant seat feature.
 */
const ROLE_FEATURE: Partial<Record<Role, Feature>> = { accountant: 'accountant_seat' };

export type SeatCheck =
  | { ok: true; seats: number; used: number }
  | { ok: false; reason: 'role_not_in_plan'; minPlan: PlanCode | null }
  | { ok: false; reason: 'no_free_seat'; seats: number; used: number };

/**
 * May a business on `planCode`, already using `seatsUsed` seats (owner included),
 * add one more member with `role`? Deny-by-default: an unknown plan has 0 seats,
 * the owner role is never grantable here, and a garbled seat count (negative,
 * fractional, NaN) fails closed instead of opening a seat.
 */
export function checkTeamSeat(planCode: string, role: Role, seatsUsed: number): SeatCheck {
  const seats = planSeats(planCode);
  if (role === 'owner') return { ok: false, reason: 'role_not_in_plan', minPlan: null };
  const feature = ROLE_FEATURE[role];
  if (feature && !planAllows(planCode, feature)) return { ok: false, reason: 'role_not_in_plan', minPlan: minPlanFor(feature) };
  if (!Number.isInteger(seatsUsed) || seatsUsed < 0 || seatsUsed >= seats) {
    return { ok: false, reason: 'no_free_seat', seats, used: Number.isFinite(seatsUsed) ? seatsUsed : seats };
  }
  return { ok: true, seats, used: seatsUsed };
}
