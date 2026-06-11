/**
 * AR/AP aging buckets (PRD v1.2 §C2): current / 1–30 / 31–60 / 61–90 / 90+ days past due,
 * measured against the report's as-of date. Buckets are COMPUTED, never stored.
 * Invariant: sum of buckets === grand total. `verifyAgingReport` recomputes independently
 * so a tampered report is caught (the adversarial-probe contract of CLAUDE.md §8).
 */
import { MoneyError, type Paisa } from '../money/money.js';

export type AgingBucketKey =
  | 'current'
  | 'days1to30'
  | 'days31to60'
  | 'days61to90'
  | 'days90plus'
  | 'noDueDate';

export const AGING_BUCKET_KEYS: readonly AgingBucketKey[] = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'days90plus',
  'noDueDate',
];

export interface AgingRow {
  balancePaisa: Paisa;
  /** null = no due date recorded — shown as "no due date", never guessed (v1.2 §C12). */
  dueOn: Date | null;
  partyName?: string;
  invoiceNo?: string;
}

export interface AgingReport {
  asOf: Date;
  buckets: Record<AgingBucketKey, Paisa>;
  totalPaisa: Paisa;
}

const MS_PER_DAY = 86_400_000;

function utcMidnight(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole days past due (negative/zero = not yet due). null when there is no due date. */
export function daysPastDue(dueOn: Date | null, asOf: Date): number | null {
  if (dueOn === null) return null;
  return Math.floor((utcMidnight(asOf) - utcMidnight(dueOn)) / MS_PER_DAY);
}

export function bucketForDays(days: number | null): AgingBucketKey {
  if (days === null) return 'noDueDate';
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'days90plus';
}

export function buildAgingReport(rows: readonly AgingRow[], asOf: Date): AgingReport {
  const buckets: Record<AgingBucketKey, Paisa> = {
    current: 0n,
    days1to30: 0n,
    days31to60: 0n,
    days61to90: 0n,
    days90plus: 0n,
    noDueDate: 0n,
  };
  let totalPaisa = 0n;
  for (const row of rows) {
    if (row.balancePaisa < 0n) {
      throw new MoneyError(
        `negative balance ${row.balancePaisa} for ${row.partyName ?? 'unknown party'} — fix allocations first`,
      );
    }
    buckets[bucketForDays(daysPastDue(row.dueOn, asOf))] += row.balancePaisa;
    totalPaisa += row.balancePaisa;
  }
  return { asOf, buckets, totalPaisa };
}

export interface AgingVerification {
  result: 'pass' | 'fail';
  reasons: string[];
}

/** Independently recompute the report from source rows; any mismatch fails (hold + ask, never send). */
export function verifyAgingReport(
  report: AgingReport,
  rows: readonly AgingRow[],
  asOf: Date,
): AgingVerification {
  const reasons: string[] = [];
  const fresh = buildAgingReport(rows, asOf);

  for (const key of AGING_BUCKET_KEYS) {
    if (report.buckets[key] !== fresh.buckets[key]) {
      reasons.push(`bucket ${key}: report says ${report.buckets[key]}, ledger says ${fresh.buckets[key]}`);
    }
  }
  if (report.totalPaisa !== fresh.totalPaisa) {
    reasons.push(`grand total: report says ${report.totalPaisa}, ledger says ${fresh.totalPaisa}`);
  }
  const bucketSum = AGING_BUCKET_KEYS.reduce((sum, k) => sum + report.buckets[k], 0n);
  if (bucketSum !== report.totalPaisa) {
    reasons.push(`buckets sum to ${bucketSum} but report total is ${report.totalPaisa}`);
  }

  return { result: reasons.length === 0 ? 'pass' : 'fail', reasons };
}
