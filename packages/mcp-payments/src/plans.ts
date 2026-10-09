/**
 * Subscription plans (v2.0 P10 billing) — the SMB pays HisabKitab.
 *
 * Prices + names are the SINGLE SOURCE OF TRUTH in `@hisab/shared` (PLAN_META), so
 * the payments service, the orchestrator's dunning, and feature-gating all agree.
 * This module adds the presentation copy (blurb + feature bullets) on top. Prices
 * are integer paisa (CLAUDE.md §3). The landing /pay page mirrors these numbers.
 *
 * Nepali gateways have no card-on-file auto-debit, so a subscription is modelled
 * as a PREPAID PERIOD: the owner pays for one month up front (PRD v2.0 §2). No
 * silent recurring charge.
 */
import { PLAN_META, type PlanCode } from '@hisab/shared';

export type { PlanCode };

export interface Plan {
  code: PlanCode;
  name: string;
  /** Monthly price in integer paisa (from PLAN_META — single source of truth). */
  pricePaisa: number;
  blurb: string;
  features: string[];
}

/** Presentation copy per plan, merged with the canonical name/price from PLAN_META. */
const PLAN_COPY: Record<PlanCode, { blurb: string; features: string[] }> = {
  starter: {
    blurb: 'For a solo shop finding its rhythm.',
    features: ['Log by photo or text', 'VAT reminders', 'Nil return prep', 'Just you (the owner)'],
  },
  pro: {
    blurb: 'For a growing business with credit customers.',
    features: [
      'Everything in Starter',
      'Debtors and creditors',
      'Statements and aging',
      'Up to 3 people: add an accountant, auditor, staff or viewer',
    ],
  },
  business: {
    blurb: 'For an established SMB and its accountant.',
    features: ['Everything in Pro', 'All PDF reports', 'Up to 10 people', 'Priority support'],
  },
};

/** Ordered cheapest → priciest; the order the agent and the page present them. */
export const SUBSCRIPTION_PLANS: readonly Plan[] = (['starter', 'pro', 'business'] as const).map((code) => ({
  code,
  name: PLAN_META[code].name,
  pricePaisa: PLAN_META[code].pricePaisa,
  ...PLAN_COPY[code],
}));

const BY_CODE = new Map<string, Plan>(SUBSCRIPTION_PLANS.map((p) => [p.code, p]));

/** Look up a plan by code; undefined for an unknown code (caller rejects). */
export function getPlan(code: string): Plan | undefined {
  return BY_CODE.get(code);
}

/** Rupee string for display/audit, derived from paisa (never the other way). */
export function rupees(pricePaisa: number): string {
  return `Rs ${(pricePaisa / 100).toLocaleString('en-IN')}`;
}
