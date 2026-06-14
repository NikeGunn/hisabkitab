/**
 * AR/AP payment allocation (PRD v1.2 §C3). Pure, exact bigint paisa math.
 *
 * A payment received (AR) or paid (AP) is applied against one or more open
 * invoices/bills, decrementing each target's balance. Two modes:
 *   - AUTO: oldest-first (FIFO by issue/bill date, then by id for stability).
 *   - MANUAL: the owner names target+amount; we validate each against its balance.
 *
 * Invariants enforced here (the tools rely on these, the DB also CHECKs balance ≥ 0):
 *   - no single allocation exceeds its target's open balance,
 *   - the sum of allocations never exceeds the payment amount,
 *   - over-allocation (payment bigger than total open balance) is REJECTED, not
 *     silently absorbed — the owner is asked (an over-payment/advance is a separate flow).
 * The actual balance decrement happens in ONE locked DB transaction in the tool;
 * this module only computes the plan and proves it reconciles.
 */
import { MoneyError, type Paisa } from '../money/money.js';

/** An open invoice/bill a payment can be applied to. */
export interface AllocationTarget {
  id: string;
  /** Issue date (AR) or bill date (AP) — used to order oldest-first. */
  datedOn: Date;
  balancePaisa: Paisa;
}

/** One requested manual allocation (owner named the target + amount). */
export interface AllocationRequest {
  targetId: string;
  amountPaisa: Paisa;
}

export interface AllocationLine {
  targetId: string;
  amountPaisa: Paisa;
  /** Target balance AFTER this allocation (for echo + DB write). */
  newBalancePaisa: Paisa;
}

export interface AllocationPlan {
  lines: AllocationLine[];
  allocatedPaisa: Paisa;
  /** Payment amount left unapplied. Must be 0n for a valid plan (else over-payment). */
  unappliedPaisa: Paisa;
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationError';
  }
}

function assertPositive(amountPaisa: Paisa, label: string): void {
  if (amountPaisa <= 0n) throw new AllocationError(`${label} must be a positive amount, got ${amountPaisa}`);
}

/** Oldest-first then id-stable, so the same inputs always yield the same plan. */
function oldestFirst(a: AllocationTarget, b: AllocationTarget): number {
  const dt = a.datedOn.getTime() - b.datedOn.getTime();
  return dt !== 0 ? dt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * AUTO allocation: apply `amountPaisa` to open targets oldest-first, fully paying
 * each before moving on, partially paying the last. Rejects if the payment exceeds
 * the total open balance (over-payment → ask the owner, never absorb).
 */
export function planAutoAllocation(amountPaisa: Paisa, targets: readonly AllocationTarget[]): AllocationPlan {
  assertPositive(amountPaisa, 'payment amount');
  const open = targets.filter((t) => t.balancePaisa > 0n).sort(oldestFirst);

  const lines: AllocationLine[] = [];
  let remaining = amountPaisa;
  for (const t of open) {
    if (remaining <= 0n) break;
    const apply = remaining < t.balancePaisa ? remaining : t.balancePaisa;
    lines.push({ targetId: t.id, amountPaisa: apply, newBalancePaisa: t.balancePaisa - apply });
    remaining -= apply;
  }

  if (remaining > 0n) {
    const totalOpen = open.reduce((s, t) => s + t.balancePaisa, 0n);
    throw new AllocationError(
      `payment ${amountPaisa} exceeds total open balance ${totalOpen} by ${remaining} — ` +
        `confirm this is an advance/overpayment, or correct the amount`,
    );
  }
  return finalize(lines, amountPaisa);
}

/**
 * MANUAL allocation: the owner specified each target+amount. Validate every line
 * against its current balance; no line may overpay its target, no target twice,
 * and the lines must sum to exactly the payment amount (no stray remainder).
 */
export function planManualAllocation(
  amountPaisa: Paisa,
  requests: readonly AllocationRequest[],
  targets: readonly AllocationTarget[],
): AllocationPlan {
  assertPositive(amountPaisa, 'payment amount');
  if (requests.length === 0) throw new AllocationError('no allocations specified');

  const byId = new Map(targets.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const lines: AllocationLine[] = [];

  for (const req of requests) {
    assertPositive(req.amountPaisa, `allocation to ${req.targetId}`);
    if (seen.has(req.targetId)) {
      throw new AllocationError(`target ${req.targetId} allocated more than once — combine into one line`);
    }
    seen.add(req.targetId);
    const target = byId.get(req.targetId);
    if (!target) throw new AllocationError(`target ${req.targetId} is not an open invoice/bill for this party`);
    if (req.amountPaisa > target.balancePaisa) {
      throw new AllocationError(
        `allocation ${req.amountPaisa} to ${req.targetId} exceeds its open balance ${target.balancePaisa}`,
      );
    }
    lines.push({
      targetId: req.targetId,
      amountPaisa: req.amountPaisa,
      newBalancePaisa: target.balancePaisa - req.amountPaisa,
    });
  }

  const plan = finalize(lines, amountPaisa);
  if (plan.unappliedPaisa !== 0n) {
    throw new AllocationError(
      `allocations sum to ${plan.allocatedPaisa} but the payment is ${amountPaisa} ` +
        `(${plan.unappliedPaisa} unapplied) — every rupee must be allocated`,
    );
  }
  return plan;
}

function finalize(lines: AllocationLine[], amountPaisa: Paisa): AllocationPlan {
  const allocated = lines.reduce((s, l) => s + l.amountPaisa, 0n);
  if (allocated > amountPaisa) {
    // unreachable via the planners above, but a hard guard: never allocate more than paid.
    throw new MoneyError(`allocated ${allocated} exceeds payment ${amountPaisa}`);
  }
  return { lines, allocatedPaisa: allocated, unappliedPaisa: amountPaisa - allocated };
}
