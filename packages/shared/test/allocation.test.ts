import { describe, expect, it } from 'vitest';
import {
  AllocationError,
  planAutoAllocation,
  planManualAllocation,
  type AllocationTarget,
} from '../src/allocation/allocation.js';

const day = (d: number): Date => new Date(2026, 2, d);

/** Three open invoices, oldest first: I1 (1000) on the 1st, I2 (2000) on the 5th, I3 (500) on the 10th. */
const targets: AllocationTarget[] = [
  { id: 'I2', datedOn: day(5), balancePaisa: 200_000n },
  { id: 'I1', datedOn: day(1), balancePaisa: 100_000n },
  { id: 'I3', datedOn: day(10), balancePaisa: 50_000n },
];

describe('planAutoAllocation (oldest-first)', () => {
  it('pays the single oldest invoice partially', () => {
    const plan = planAutoAllocation(60_000n, targets);
    expect(plan.lines).toEqual([{ targetId: 'I1', amountPaisa: 60_000n, newBalancePaisa: 40_000n }]);
    expect(plan.unappliedPaisa).toBe(0n);
  });

  it('fully pays the oldest, then partially the next, in date order', () => {
    const plan = planAutoAllocation(150_000n, targets);
    expect(plan.lines).toEqual([
      { targetId: 'I1', amountPaisa: 100_000n, newBalancePaisa: 0n },
      { targetId: 'I2', amountPaisa: 50_000n, newBalancePaisa: 150_000n },
    ]);
  });

  it('INVARIANT: sum of allocations == payment, every line ≤ its balance', () => {
    const plan = planAutoAllocation(320_000n, targets); // exactly clears I1+I2+I3+... = 350k? no, 320k
    const total = plan.lines.reduce((s, l) => s + l.amountPaisa, 0n);
    expect(total).toBe(320_000n);
    expect(plan.unappliedPaisa).toBe(0n);
    // I1 100k (cleared), I2 200k (cleared), I3 20k of 50k
    expect(plan.lines.map((l) => l.targetId)).toEqual(['I1', 'I2', 'I3']);
    expect(plan.lines[2]).toEqual({ targetId: 'I3', amountPaisa: 20_000n, newBalancePaisa: 30_000n });
  });

  it('clears all open invoices exactly', () => {
    const plan = planAutoAllocation(350_000n, targets);
    expect(plan.lines.every((l) => l.newBalancePaisa === 0n)).toBe(true);
    expect(plan.unappliedPaisa).toBe(0n);
  });

  it('ignores already-paid (zero-balance) targets', () => {
    const withPaid: AllocationTarget[] = [...targets, { id: 'PAID', datedOn: day(0), balancePaisa: 0n }];
    const plan = planAutoAllocation(60_000n, withPaid);
    expect(plan.lines[0]?.targetId).toBe('I1'); // not PAID, despite being "oldest"
  });

  it('PROBE: over-payment (more than total open balance) is REJECTED, not absorbed', () => {
    expect(() => planAutoAllocation(350_001n, targets)).toThrow(AllocationError);
    try {
      planAutoAllocation(400_000n, targets);
    } catch (e) {
      expect((e as Error).message).toMatch(/exceeds total open balance 350000 by 50000/);
    }
  });

  it('PROBE: non-positive payment is rejected', () => {
    expect(() => planAutoAllocation(0n, targets)).toThrow(AllocationError);
    expect(() => planAutoAllocation(-1n, targets)).toThrow(AllocationError);
  });
});

describe('planManualAllocation (owner-specified)', () => {
  it('applies each named line and reports new balances', () => {
    const plan = planManualAllocation(
      130_000n,
      [
        { targetId: 'I1', amountPaisa: 100_000n },
        { targetId: 'I3', amountPaisa: 30_000n },
      ],
      targets,
    );
    expect(plan.lines).toEqual([
      { targetId: 'I1', amountPaisa: 100_000n, newBalancePaisa: 0n },
      { targetId: 'I3', amountPaisa: 30_000n, newBalancePaisa: 20_000n },
    ]);
    expect(plan.unappliedPaisa).toBe(0n);
  });

  it('PROBE: a line exceeding its target balance is rejected', () => {
    expect(() =>
      planManualAllocation(120_000n, [{ targetId: 'I1', amountPaisa: 120_000n }], targets),
    ).toThrow(/exceeds its open balance 100000/);
  });

  it('PROBE: lines that do not sum to the payment are rejected (stray remainder)', () => {
    expect(() =>
      planManualAllocation(130_000n, [{ targetId: 'I1', amountPaisa: 100_000n }], targets),
    ).toThrow(/unapplied/);
  });

  it('PROBE: the same target allocated twice is rejected', () => {
    expect(() =>
      planManualAllocation(
        100_000n,
        [
          { targetId: 'I1', amountPaisa: 50_000n },
          { targetId: 'I1', amountPaisa: 50_000n },
        ],
        targets,
      ),
    ).toThrow(/more than once/);
  });

  it('PROBE: an unknown target id is rejected', () => {
    expect(() =>
      planManualAllocation(10_000n, [{ targetId: 'NOPE', amountPaisa: 10_000n }], targets),
    ).toThrow(/not an open invoice\/bill/);
  });
});
