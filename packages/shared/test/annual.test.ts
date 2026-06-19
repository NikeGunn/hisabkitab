import { describe, expect, it } from 'vitest';
import { annualVatSummary, settleMonth, type MonthlyVat } from '../src/accounting/annual.js';
import { MoneyError } from '../src/money/money.js';

/** Build a Shrawan-first 12-month fiscal year from (output, input) paisa pairs. */
function fy(pairs: Array<[bigint, bigint]>): MonthlyVat[] {
  const order = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]; // Shrawan … Ashadh
  return pairs.map(([outputVatPaisa, inputVatPaisa], i) => ({
    bsMonth: order[i]!,
    outputVatPaisa,
    inputVatPaisa,
  }));
}

describe('settleMonth (single-month carry-forward)', () => {
  it('output > credit → pays the difference, carries nothing', () => {
    const s = settleMonth({ bsMonth: 4, outputVatPaisa: 130_000n, inputVatPaisa: 50_000n }, 0n);
    expect(s.netPayablePaisa).toBe(80_000n);
    expect(s.carryForwardPaisa).toBe(0n);
  });

  it('input + brought-forward > output → pays nothing, carries the excess', () => {
    const s = settleMonth({ bsMonth: 4, outputVatPaisa: 50_000n, inputVatPaisa: 60_000n }, 20_000n);
    expect(s.netPayablePaisa).toBe(0n);
    expect(s.carryForwardPaisa).toBe(30_000n); // 60k + 20k − 50k
  });

  it('exactly equal → pays nothing, carries nothing', () => {
    const s = settleMonth(
      { bsMonth: 4, outputVatPaisa: 100_000n, inputVatPaisa: 40_000n },
      60_000n,
    );
    expect(s.netPayablePaisa).toBe(0n);
    expect(s.carryForwardPaisa).toBe(0n);
  });

  it('PROBE: negative input is rejected', () => {
    expect(() => settleMonth({ bsMonth: 4, outputVatPaisa: 10n, inputVatPaisa: -1n }, 0n)).toThrow(
      MoneyError,
    );
  });
});

describe('annualVatSummary (fiscal-year carry-forward)', () => {
  it('a credit-heavy month offsets a later payable month within the year', () => {
    // Month 1: input 100k > output 0 → carry 100k. Month 2: output 130k − own 0 − carry 100k = 30k.
    const summary = annualVatSummary(
      2082,
      fy([
        [0n, 100_000n],
        [130_000n, 0n],
      ]),
    );
    expect(summary.months[0]!.carryForwardPaisa).toBe(100_000n);
    expect(summary.months[1]!.broughtForwardPaisa).toBe(100_000n);
    expect(summary.months[1]!.netPayablePaisa).toBe(30_000n);
    expect(summary.totalNetPayablePaisa).toBe(30_000n);
    expect(summary.closingCarryForwardPaisa).toBe(0n);
  });

  it('INVARIANT: annual net payable == Σ monthly net payable', () => {
    const summary = annualVatSummary(
      2082,
      fy([
        [200_000n, 50_000n],
        [0n, 80_000n],
        [120_000n, 10_000n],
        [60_000n, 60_000n],
      ]),
    );
    const sum = summary.months.reduce((a, m) => a + m.netPayablePaisa, 0n);
    expect(summary.totalNetPayablePaisa).toBe(sum);
    expect(summary.totalOutputVatPaisa).toBe(380_000n);
    expect(summary.totalInputVatPaisa).toBe(200_000n);
  });

  it('excess credit at year-end becomes the closing carry-forward into next FY', () => {
    const summary = annualVatSummary(2082, fy([[10_000n, 90_000n]]));
    expect(summary.totalNetPayablePaisa).toBe(0n);
    expect(summary.closingCarryForwardPaisa).toBe(80_000n);
  });

  it('an opening carry-forward from the prior FY offsets the first month', () => {
    const summary = annualVatSummary(2082, fy([[50_000n, 0n]]), 70_000n);
    expect(summary.months[0]!.broughtForwardPaisa).toBe(70_000n);
    expect(summary.months[0]!.netPayablePaisa).toBe(0n);
    expect(summary.closingCarryForwardPaisa).toBe(20_000n);
  });

  it('PROBE: a wrong month count (0 or >12) is REJECTED — never summarize a garbled year', () => {
    expect(() => annualVatSummary(2082, [])).toThrow(/1\.\.12 months/);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      bsMonth: (i % 12) + 1,
      outputVatPaisa: 0n,
      inputVatPaisa: 0n,
    }));
    expect(() => annualVatSummary(2082, thirteen)).toThrow(/1\.\.12 months/);
  });

  it('PROBE: an out-of-range BS month is REJECTED', () => {
    expect(() =>
      annualVatSummary(2082, [{ bsMonth: 13, outputVatPaisa: 0n, inputVatPaisa: 0n }]),
    ).toThrow(/BS month/);
  });

  it('PROBE: a negative opening carry-forward is REJECTED', () => {
    expect(() => annualVatSummary(2082, fy([[0n, 0n]]), -1n)).toThrow(MoneyError);
  });
});
