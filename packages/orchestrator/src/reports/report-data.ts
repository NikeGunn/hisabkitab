/**
 * Report DATA layer (PRD v1.2 §C4.1 determinism rule). Calls the read-only, tenant-scoped
 * Ledger analytics tools, then builds a fully-formatted ReportModel AND an independent
 * reconciliation verdict. The agent picks report_type + filters; EVERY number here comes
 * from a validated query object — never the model's free text.
 *
 * reconcile-or-hold (PRD §C9): row balances sum to the report total AND aging buckets sum
 * to the grand total. Any mismatch → reconciled:false + named failing checks → the job
 * holds delivery and the agent asks instead of sending (the Pre-delivery Audit Gate).
 */
import { formatNpr } from '@hisab/shared';
import {
  agingBucketSum,
  agingOverdue,
  type AgingSummary,
  type ReportModel,
  type ReportType,
} from './model.js';

/** Minimal client surface the data layer needs (real MCP client or a test double). */
export interface LedgerReadClient {
  call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface TenantInfo {
  businessName: string;
  panOrVatNo: string;
}

export interface ReconcileCheck {
  name: string;
  result: 'PASS' | 'FAIL';
  detail?: string;
}

export interface ReportBuildResult {
  reconciled: boolean;
  checks: ReconcileCheck[];
  model: ReportModel;
  /** one-line WhatsApp caption summarising the report (figures from validated data). */
  summaryLine: string;
}

// ---- shared shapes returned by the analytics tools (mirror arap-tools.ts) ----
interface AgingApi {
  current_paisa: number;
  days1to30_paisa: number;
  days31to60_paisa: number;
  days61to90_paisa: number;
  days90plus_paisa: number;
  no_due_date_paisa: number;
}
interface ArApSummaryApi {
  as_of: string;
  reconciled: boolean;
  reconcile_reasons?: string[];
  rows: Array<{
    party: string;
    ref: string | null;
    dated_on: string;
    due_on: string | null;
    total_paisa: number;
    paid_paisa: number;
    balance_paisa: number;
    days_overdue: number;
  }>;
  aging: AgingApi;
  total_paisa: number;
}
interface StatementApi {
  found: boolean;
  party: string;
  lines: Array<{ date: string; kind: string; ref: string | null; debit_paisa: number; credit_paisa: number; running_balance_paisa: number }>;
  closing_balance_paisa: number;
  line_count: number;
}
interface SalesSummaryApi {
  bs_year: number;
  bs_month: number;
  net_paisa: number;
  vat_paisa: number;
  gross_paisa: number;
  count: number;
}

const nowIso = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
const apiToAging = (a: AgingApi): AgingSummary => ({
  current: BigInt(a.current_paisa),
  days1to30: BigInt(a.days1to30_paisa),
  days31to60: BigInt(a.days31to60_paisa),
  days61to90: BigInt(a.days61to90_paisa),
  days90plus: BigInt(a.days90plus_paisa),
  noDueDate: BigInt(a.no_due_date_paisa),
});

/** The reconcile-or-hold gate, shared by AR & AP. */
function reconcileArAp(s: ArApSummaryApi, aging: AgingSummary): ReconcileCheck[] {
  const rowSum = s.rows.reduce((acc, r) => acc + BigInt(r.balance_paisa), 0n);
  const total = BigInt(s.total_paisa);
  const bucketSum = agingBucketSum(aging);
  return [
    {
      name: 'rows_sum_equals_total',
      result: rowSum === total ? 'PASS' : 'FAIL',
      ...(rowSum === total ? {} : { detail: `row balances sum to ${rowSum}, report total is ${total}` }),
    },
    {
      name: 'aging_buckets_sum_equals_total',
      result: bucketSum === total ? 'PASS' : 'FAIL',
      ...(bucketSum === total ? {} : { detail: `aging buckets sum to ${bucketSum}, report total is ${total}` }),
    },
    {
      name: 'tool_self_reconciled',
      result: s.reconciled ? 'PASS' : 'FAIL',
      ...(s.reconciled ? {} : { detail: (s.reconcile_reasons ?? []).join('; ') }),
    },
  ];
}

const allPass = (checks: ReconcileCheck[]): boolean => checks.every((c) => c.result === 'PASS');

export interface ReportRequest {
  type: ReportType;
  /** for statement. */
  party?: string;
  /** for receivables/payables. */
  asOf?: string;
  /** for sales summary. */
  bsYear?: number;
  bsMonth?: number;
}

/**
 * Build a fully-detailed ReportModel + reconciliation verdict for the requested report.
 * Pulls validated data via the ledger read client; formats every figure deterministically.
 */
export async function buildReport(
  client: LedgerReadClient,
  tenant: TenantInfo,
  req: ReportRequest,
): Promise<ReportBuildResult> {
  switch (req.type) {
    case 'receivables':
    case 'payables':
      return buildArAp(client, tenant, req.type, req.asOf);
    case 'statement':
      return buildStatement(client, tenant, req.party!, req.asOf);
    case 'sales_summary':
      return buildSalesSummary(client, tenant, req.bsYear!, req.bsMonth!);
  }
}

async function buildArAp(
  client: LedgerReadClient,
  tenant: TenantInfo,
  type: 'receivables' | 'payables',
  asOf?: string,
): Promise<ReportBuildResult> {
  const tool = type === 'receivables' ? 'get_receivables_summary' : 'get_payables_summary';
  const s = await client.call<ArApSummaryApi>(tool, asOf ? { as_of: asOf } : {});
  const aging = apiToAging(s.aging);
  const checks = reconcileArAp(s, aging);
  const reconciled = allPass(checks);

  const isAr = type === 'receivables';
  const refLabel = isAr ? 'Invoice' : 'Bill';
  const partyLabel = isAr ? 'Customer' : 'Supplier';
  const total = BigInt(s.total_paisa);
  const overdue = agingOverdue(aging);

  const rows = s.rows
    .slice()
    .sort((a, b) => b.days_overdue - a.days_overdue || (a.party < b.party ? -1 : 1))
    .map((r) => [
      r.party,
      r.ref ?? '—',
      r.dated_on,
      r.due_on ?? 'no due date',
      formatNpr(BigInt(r.total_paisa)),
      formatNpr(BigInt(r.paid_paisa)),
      formatNpr(BigInt(r.balance_paisa)),
      r.due_on ? String(r.days_overdue) : '—',
    ]);

  const model: ReportModel = {
    type,
    header: {
      businessName: tenant.businessName,
      panOrVatNo: tenant.panOrVatNo,
      title: isAr ? 'Receivables (Debtors) Statement' : 'Payables (Creditors) Statement',
      periodLabel: `As of ${s.as_of}`,
      generatedAtIso: nowIso(),
    },
    summary: [
      { label: isAr ? 'Total Receivable' : 'Total Payable', valuePaisa: total, emphasize: true },
      { label: 'Overdue', valuePaisa: overdue },
      { label: partyLabel + 's', text: String(new Set(s.rows.map((r) => r.party)).size) },
      { label: 'Open ' + refLabel + 's', text: String(s.rows.length) },
    ],
    columns: [
      { key: 'party', label: partyLabel },
      { key: 'ref', label: refLabel + ' No' },
      { key: 'dated', label: isAr ? 'Issued' : 'Billed' },
      { key: 'due', label: 'Due' },
      { key: 'total', label: 'Total', numeric: true },
      { key: 'paid', label: 'Paid', numeric: true },
      { key: 'balance', label: 'Balance', numeric: true },
      { key: 'overdue', label: 'Days', numeric: true },
    ],
    rows,
    totalsRow: ['TOTAL', '', '', '', '', '', formatNpr(total), ''],
    aging,
    grandTotalPaisa: total,
    grandTotalLabel: isAr ? 'TOTAL RECEIVABLE' : 'TOTAL PAYABLE',
  };

  const summaryLine = reconciled
    ? `${isAr ? 'Debtors' : 'Creditors'} as of ${s.as_of}: total ${isAr ? 'receivable' : 'payable'} ${formatNpr(total)}, of which ${formatNpr(overdue)} is overdue. ${new Set(s.rows.map((r) => r.party)).size} ${partyLabel.toLowerCase()}s.`
    : `Could not reconcile the ${type} report — holding it. Please check the entries.`;

  return { reconciled, checks, model, summaryLine };
}

async function buildStatement(
  client: LedgerReadClient,
  tenant: TenantInfo,
  party: string,
  asOf?: string,
): Promise<ReportBuildResult> {
  const s = await client.call<StatementApi>('get_statement', { party, ...(asOf ? { to: asOf } : {}) });
  if (!s.found) {
    return {
      reconciled: false,
      checks: [{ name: 'party_exists', result: 'FAIL', detail: `no party named "${party}" in this business` }],
      model: emptyModel(tenant, 'statement', 'Statement of Account', `Party: ${party}`),
      summaryLine: `I couldn't find a party named "${party}". Could you confirm the name?`,
    };
  }

  // Reconcile: running balance must be internally consistent (debit−credit cumulates to closing).
  let running = 0n;
  for (const l of s.lines) running += BigInt(l.debit_paisa) - BigInt(l.credit_paisa);
  const closing = BigInt(s.closing_balance_paisa);
  const checks: ReconcileCheck[] = [
    {
      name: 'running_balance_reconciles',
      result: running === closing ? 'PASS' : 'FAIL',
      ...(running === closing ? {} : { detail: `cumulative debit−credit is ${running}, closing balance is ${closing}` }),
    },
  ];
  const reconciled = allPass(checks);

  const rows = s.lines.map((l) => [
    l.date,
    l.kind,
    l.ref ?? '—',
    l.debit_paisa ? formatNpr(BigInt(l.debit_paisa)) : '',
    l.credit_paisa ? formatNpr(BigInt(l.credit_paisa)) : '',
    formatNpr(BigInt(l.running_balance_paisa)),
  ]);

  const totalDebit = s.lines.reduce((a, l) => a + BigInt(l.debit_paisa), 0n);
  const totalCredit = s.lines.reduce((a, l) => a + BigInt(l.credit_paisa), 0n);

  const model: ReportModel = {
    type: 'statement',
    header: {
      businessName: tenant.businessName,
      panOrVatNo: tenant.panOrVatNo,
      title: 'Statement of Account',
      subtitle: party,
      periodLabel: asOf ? `As of ${asOf}` : 'All transactions to date',
      generatedAtIso: nowIso(),
    },
    summary: [
      { label: 'Closing Balance', valuePaisa: closing, emphasize: true },
      { label: 'Total Debit', valuePaisa: totalDebit },
      { label: 'Total Credit', valuePaisa: totalCredit },
      { label: 'Transactions', text: String(s.line_count) },
    ],
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'kind', label: 'Particulars' },
      { key: 'ref', label: 'Ref' },
      { key: 'debit', label: 'Debit', numeric: true },
      { key: 'credit', label: 'Credit', numeric: true },
      { key: 'running', label: 'Balance', numeric: true },
    ],
    rows,
    totalsRow: ['', 'CLOSING BALANCE', '', formatNpr(totalDebit), formatNpr(totalCredit), formatNpr(closing)],
    grandTotalPaisa: closing,
    grandTotalLabel: 'CLOSING BALANCE',
  };

  const dir = closing > 0n ? 'owes you' : closing < 0n ? 'you owe' : 'is settled with';
  const summaryLine = reconciled
    ? `Statement for ${party}: ${s.line_count} transactions, closing balance ${formatNpr(closing > 0n ? closing : -closing)} (${party} ${dir}).`
    : `Could not reconcile ${party}'s statement — holding it.`;

  return { reconciled, checks, model, summaryLine };
}

async function buildSalesSummary(
  client: LedgerReadClient,
  tenant: TenantInfo,
  bsYear: number,
  bsMonth: number,
): Promise<ReportBuildResult> {
  const s = await client.call<SalesSummaryApi>('get_sales_summary', { bs_year: bsYear, bs_month: bsMonth });
  const gross = BigInt(s.gross_paisa);
  const net = BigInt(s.net_paisa);
  const vat = BigInt(s.vat_paisa);
  const checks: ReconcileCheck[] = [
    {
      name: 'net_plus_vat_equals_gross',
      result: net + vat === gross ? 'PASS' : 'FAIL',
      ...(net + vat === gross ? {} : { detail: `net ${net} + VAT ${vat} ≠ gross ${gross}` }),
    },
  ];
  const reconciled = allPass(checks);

  const model: ReportModel = {
    type: 'sales_summary',
    header: {
      businessName: tenant.businessName,
      panOrVatNo: tenant.panOrVatNo,
      title: 'Sales Summary',
      periodLabel: `BS ${bsYear}-${String(bsMonth).padStart(2, '0')}`,
      generatedAtIso: nowIso(),
    },
    summary: [
      { label: 'Gross Sales', valuePaisa: gross, emphasize: true },
      { label: 'Taxable (Net)', valuePaisa: net },
      { label: 'Output VAT', valuePaisa: vat },
      { label: 'Invoices', text: String(s.count) },
    ],
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'amount', label: 'Amount', numeric: true },
    ],
    rows: [
      ['Taxable sales (excl. VAT)', formatNpr(net)],
      ['Output VAT (13%)', formatNpr(vat)],
      ['Number of confirmed sales', String(s.count)],
    ],
    totalsRow: ['GROSS SALES', formatNpr(gross)],
    grandTotalPaisa: gross,
    grandTotalLabel: 'GROSS SALES',
  };

  return {
    reconciled,
    checks,
    model,
    summaryLine: reconciled
      ? `Sales summary for BS ${bsYear}-${String(bsMonth).padStart(2, '0')}: gross ${formatNpr(gross)} (taxable ${formatNpr(net)} + VAT ${formatNpr(vat)}) across ${s.count} sales.`
      : `Could not reconcile the sales summary — holding it.`,
  };
}

function emptyModel(tenant: TenantInfo, type: ReportType, title: string, subtitle: string): ReportModel {
  return {
    type,
    header: { businessName: tenant.businessName, panOrVatNo: tenant.panOrVatNo, title, subtitle, periodLabel: '', generatedAtIso: nowIso() },
    summary: [],
    columns: [{ key: 'note', label: 'Note' }],
    rows: [],
    grandTotalPaisa: 0n,
    grandTotalLabel: 'TOTAL',
  };
}
