/**
 * Report MODEL (PRD v1.2 §C4) — the deterministic, validated shape the renderer turns
 * into a professional, Tally-grade PDF. Numbers here are integer paisa; the renderer
 * formats them with formatNpr. The agent NEVER hand-writes any figure into a report — it
 * only chooses the report type + filters; every number originates from a validated ledger
 * query object. The model carries enough structure for a detailed report: a titled
 * header block, a body table WITH a totals row, optional summary metrics, and an aging
 * matrix, plus the statutory footer/disclaimer.
 */
import { formatNpr, type Paisa } from '@hisab/shared';

export type ReportType = 'receivables' | 'payables' | 'statement' | 'sales_summary';

export interface ReportHeader {
  businessName: string;
  panOrVatNo: string;
  title: string;
  /** "As of 14 Jun 2026" / "Baisakh 2082 (BS)" — built deterministically by the data layer. */
  periodLabel: string;
  /** secondary line, e.g. "Statement of Account · Sharma Traders". */
  subtitle?: string;
  generatedAtIso: string;
}

export interface ReportColumn {
  key: string;
  label: string;
  /** right-align money/number columns. */
  numeric?: boolean;
  /** explicit column width (pdfmake units); default auto/star. */
  width?: number | '*' | 'auto';
}

export interface AgingSummary {
  current: Paisa;
  days1to30: Paisa;
  days31to60: Paisa;
  days61to90: Paisa;
  days90plus: Paisa;
  noDueDate: Paisa;
}

/** One headline metric shown in the summary band (e.g. "Total receivable", "Overdue"). */
export interface SummaryMetric {
  label: string;
  valuePaisa?: Paisa;
  /** non-money metric (count, days). */
  text?: string;
  emphasize?: boolean;
}

export interface ReportModel {
  type: ReportType;
  header: ReportHeader;
  /** headline metrics rendered as a band of cards above the table. */
  summary: SummaryMetric[];
  columns: ReportColumn[];
  /** rows of stringified, already-formatted cell values (money via formatNpr). */
  rows: string[][];
  /** optional totals row appended to the body table (per-column; '' to skip a cell). */
  totalsRow?: string[];
  /** optional aging matrix (receivables/payables). */
  aging?: AgingSummary;
  grandTotalPaisa: Paisa;
  grandTotalLabel: string;
}

export const DISCLAIMER =
  'Prepared based on entries recorded in the system, as of the date shown. ' +
  'This is a bookkeeping cross-check, not a substitute for audited financial statements.';

/** Aging block as label/value rows, in fixed bucket order. */
export function agingRows(aging: AgingSummary): Array<[string, string]> {
  return [
    ['Current (not yet due)', formatNpr(aging.current)],
    ['1 – 30 days overdue', formatNpr(aging.days1to30)],
    ['31 – 60 days overdue', formatNpr(aging.days31to60)],
    ['61 – 90 days overdue', formatNpr(aging.days61to90)],
    ['Over 90 days overdue', formatNpr(aging.days90plus)],
    ['No due date recorded', formatNpr(aging.noDueDate)],
  ];
}

/** Sum of every aging bucket — must equal the report grand total (reconcile invariant). */
export function agingBucketSum(aging: AgingSummary): Paisa {
  return (
    aging.current +
    aging.days1to30 +
    aging.days31to60 +
    aging.days61to90 +
    aging.days90plus +
    aging.noDueDate
  );
}

/** Overdue portion = everything past due (all buckets except current + no-due-date). */
export function agingOverdue(aging: AgingSummary): Paisa {
  return aging.days1to30 + aging.days31to60 + aging.days61to90 + aging.days90plus;
}
