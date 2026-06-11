import { describe, expect, it } from 'vitest';
import { MoneyError } from '../src/money/money.js';
import {
  AGING_BUCKET_KEYS,
  bucketForDays,
  buildAgingReport,
  daysPastDue,
  verifyAgingReport,
  type AgingRow,
} from '../src/aging/aging.js';

const ASOF = new Date(2026, 5, 11);
const due = (daysAgo: number): Date => new Date(2026, 5, 11 - daysAgo);

describe('bucket boundaries', () => {
  it('maps every boundary exactly (30/31, 60/61, 90/91)', () => {
    expect(bucketForDays(-5)).toBe('current');
    expect(bucketForDays(0)).toBe('current');
    expect(bucketForDays(1)).toBe('days1to30');
    expect(bucketForDays(30)).toBe('days1to30');
    expect(bucketForDays(31)).toBe('days31to60');
    expect(bucketForDays(60)).toBe('days31to60');
    expect(bucketForDays(61)).toBe('days61to90');
    expect(bucketForDays(90)).toBe('days61to90');
    expect(bucketForDays(91)).toBe('days90plus');
    expect(bucketForDays(null)).toBe('noDueDate');
  });

  it('daysPastDue counts whole days against the as-of date', () => {
    expect(daysPastDue(due(0), ASOF)).toBe(0);
    expect(daysPastDue(due(31), ASOF)).toBe(31);
    expect(daysPastDue(new Date(2026, 5, 20), ASOF)).toBe(-9); // not yet due
    expect(daysPastDue(null, ASOF)).toBeNull();
  });
});

describe('buildAgingReport', () => {
  const rows: AgingRow[] = [
    { balancePaisa: 100n, dueOn: due(0), partyName: 'A' },
    { balancePaisa: 200n, dueOn: due(30), partyName: 'B' },
    { balancePaisa: 400n, dueOn: due(31), partyName: 'C' },
    { balancePaisa: 600n, dueOn: due(91), partyName: 'D' },
    { balancePaisa: 700n, dueOn: null, partyName: 'E' }, // no due date — never guessed
  ];

  it('INVARIANT: buckets sum to the grand total', () => {
    const report = buildAgingReport(rows, ASOF);
    const sum = AGING_BUCKET_KEYS.reduce((acc, k) => acc + report.buckets[k], 0n);
    expect(sum).toBe(report.totalPaisa);
    expect(report.totalPaisa).toBe(2000n);
    expect(report.buckets.noDueDate).toBe(700n);
  });

  it('PROBE: negative balances are rejected, not silently bucketed', () => {
    expect(() => buildAgingReport([{ balancePaisa: -1n, dueOn: null }], ASOF)).toThrow(MoneyError);
  });

  it('partial payment moves the row, not the invariant (balance reflects allocations)', () => {
    const partiallyPaid: AgingRow[] = [{ balancePaisa: 904_000n - 500_000n, dueOn: due(45) }];
    const report = buildAgingReport(partiallyPaid, ASOF);
    expect(report.buckets.days31to60).toBe(404_000n);
    expect(report.totalPaisa).toBe(404_000n);
  });

  it('verification passes for an untouched report', () => {
    const report = buildAgingReport(rows, ASOF);
    expect(verifyAgingReport(report, rows, ASOF).result).toBe('pass');
  });

  it('PROBE: a tampered bucket fails verification with a named reason', () => {
    const report = buildAgingReport(rows, ASOF);
    const tampered = { ...report, buckets: { ...report.buckets, days90plus: 999_999n } };
    const verdict = verifyAgingReport(tampered, rows, ASOF);
    expect(verdict.result).toBe('fail');
    expect(verdict.reasons.join(' ')).toMatch(/days90plus/);
  });

  it('PROBE: a tampered grand total fails verification', () => {
    const report = buildAgingReport(rows, ASOF);
    const tampered = { ...report, totalPaisa: report.totalPaisa + 1n };
    const verdict = verifyAgingReport(tampered, rows, ASOF);
    expect(verdict.result).toBe('fail');
  });
});
