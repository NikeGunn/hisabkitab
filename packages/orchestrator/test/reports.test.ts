/**
 * Reports service (Module C-3/C-4) — verified at the surface (CLAUDE.md §8):
 *   - real PDF bytes are produced for every report type (%PDF- magic + non-trivial size),
 *   - a reconciling report is DELIVERED as a document with a figures summary,
 *   - PROBE: a report whose totals don't tie is HELD (FAIL), never sent, and logged,
 *   - PROBE: a data-pull error → BLOCKED (figure-free retry message), distinct from FAIL.
 * Pure: a fake LedgerReadClient feeds validated/lying data; the renderer runs for real.
 */
import { describe, expect, it } from 'vitest';
import { PdfmakeRenderer } from '../src/reports/render.js';
import { buildReport, type LedgerReadClient } from '../src/reports/report-data.js';
import { runReportJob, type ReportDelivery, type ReportAuditSink } from '../src/reports/report-job.js';

const TENANT = { businessName: 'Everest Buildcon Pvt Ltd', panOrVatNo: '301234567' };

/** Validated, reconciling receivables payload (rows sum == total == bucket sum). */
const goodReceivables = {
  as_of: '2026-06-14',
  reconciled: true,
  rows: [
    { party: 'Sharma Traders', ref: 'INV-1', dated_on: '2026-03-01', due_on: '2026-03-31', total_paisa: 904_000, paid_paisa: 0, balance_paisa: 904_000, days_overdue: 75 },
    { party: 'Gurung Suppliers', ref: 'INV-2', dated_on: '2026-05-20', due_on: '2026-06-20', total_paisa: 226_000, paid_paisa: 100_000, balance_paisa: 126_000, days_overdue: 0 },
  ],
  aging: { current_paisa: 126_000, days1to30_paisa: 0, days31to60_paisa: 0, days61to90_paisa: 904_000, days90plus_paisa: 0, no_due_date_paisa: 0 },
  total_paisa: 1_030_000,
};

class FakeClient implements LedgerReadClient {
  constructor(private readonly responses: Record<string, unknown>) {}
  call<T>(name: string): Promise<T> {
    if (!(name in this.responses)) throw new Error(`unexpected tool ${name}`);
    const r = this.responses[name];
    if (r instanceof Error) throw r;
    return Promise.resolve(r as T);
  }
}

class CapturingDelivery implements ReportDelivery {
  documents: Array<{ filename: string; caption: string; bytes: Buffer }> = [];
  texts: string[] = [];
  sendDocument(_to: string, bytes: Buffer, filename: string, caption: string): Promise<void> {
    this.documents.push({ filename, caption, bytes });
    return Promise.resolve();
  }
  sendText(_to: string, body: string): Promise<void> {
    this.texts.push(body);
    return Promise.resolve();
  }
}

class CapturingAudit implements ReportAuditSink {
  entries: Array<{ action: string; detail: Record<string, unknown> }> = [];
  log(entry: { tenantId: string; action: string; detail: Record<string, unknown> }): Promise<void> {
    this.entries.push({ action: entry.action, detail: entry.detail });
    return Promise.resolve();
  }
}

const isPdf = (b: Buffer): boolean => b.subarray(0, 5).toString('latin1') === '%PDF-';

describe('PDF rendering (deterministic)', () => {
  it('renders a real, non-trivial PDF for receivables with aging', async () => {
    const built = await buildReport(new FakeClient({ get_receivables_summary: goodReceivables }), TENANT, { type: 'receivables' });
    expect(built.reconciled).toBe(true);
    const pdf = await new PdfmakeRenderer().render(built.model);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('renders all report types', async () => {
    const responses = {
      get_receivables_summary: goodReceivables,
      get_payables_summary: { ...goodReceivables },
      get_statement: { found: true, party: 'Sharma Traders', lines: [{ date: '2026-03-01', kind: 'invoice', ref: 'INV-1', debit_paisa: 904_000, credit_paisa: 0, running_balance_paisa: 904_000 }], closing_balance_paisa: 904_000, line_count: 1 },
      get_sales_summary: { bs_year: 2082, bs_month: 2, net_paisa: 800_000, vat_paisa: 104_000, gross_paisa: 904_000, count: 1 },
    };
    const client = new FakeClient(responses);
    for (const req of [
      { type: 'receivables' as const },
      { type: 'payables' as const },
      { type: 'statement' as const, party: 'Sharma Traders' },
      { type: 'sales_summary' as const, bsYear: 2082, bsMonth: 2 },
    ]) {
      const built = await buildReport(client, TENANT, req);
      expect(built.reconciled).toBe(true);
      const pdf = await new PdfmakeRenderer().render(built.model);
      expect(isPdf(pdf)).toBe(true);
    }
  });
});

describe('reconcile-or-hold', () => {
  it('INVARIANT: rows + buckets tie to the grand total → reconciled', async () => {
    const built = await buildReport(new FakeClient({ get_receivables_summary: goodReceivables }), TENANT, { type: 'receivables' });
    expect(built.checks.every((c) => c.result === 'PASS')).toBe(true);
  });

  it('PROBE: a report whose buckets do not sum to the total is NOT reconciled', async () => {
    const lying = { ...goodReceivables, aging: { ...goodReceivables.aging, days90plus_paisa: 1 } };
    const built = await buildReport(new FakeClient({ get_receivables_summary: lying }), TENANT, { type: 'receivables' });
    expect(built.reconciled).toBe(false);
    expect(built.checks.find((c) => c.name === 'aging_buckets_sum_equals_total')?.result).toBe('FAIL');
  });

  it('PROBE: rows that do not sum to the total fail', async () => {
    const lying = { ...goodReceivables, rows: [{ ...goodReceivables.rows[0]!, balance_paisa: 999 }] };
    const built = await buildReport(new FakeClient({ get_receivables_summary: lying }), TENANT, { type: 'receivables' });
    expect(built.reconciled).toBe(false);
  });
});

describe('report job (deliver vs hold)', () => {
  const job = (client: LedgerReadClient) => {
    const delivery = new CapturingDelivery();
    const audit = new CapturingAudit();
    return { delivery, audit, run: (req: Parameters<typeof runReportJob>[1]['request']) => runReportJob({ client, delivery, audit }, { tenantId: 't1', toE164: '+9779800000000', tenant: TENANT, request: req }) };
  };

  it('PASS: delivers a document with a figures caption and logs report_delivered', async () => {
    const j = job(new FakeClient({ get_receivables_summary: goodReceivables }));
    const res = await j.run({ type: 'receivables' });
    expect(res.verdict).toBe('PASS');
    expect(res.delivered).toBe(true);
    expect(j.delivery.documents).toHaveLength(1);
    expect(j.delivery.documents[0]!.filename).toMatch(/Receivables-Debtors-\d{4}-\d{2}-\d{2}\.pdf/);
    expect(j.delivery.documents[0]!.caption).toMatch(/total receivable/i);
    expect(isPdf(j.delivery.documents[0]!.bytes)).toBe(true);
    expect(j.audit.entries.some((e) => e.action === 'report_delivered')).toBe(true);
  });

  it('PROBE: a non-reconciling report is HELD (FAIL), no document sent, logged as report_held', async () => {
    const lying = { ...goodReceivables, total_paisa: 999_999 };
    const j = job(new FakeClient({ get_receivables_summary: lying }));
    const res = await j.run({ type: 'receivables' });
    expect(res.verdict).toBe('FAIL');
    expect(res.delivered).toBe(false);
    expect(j.delivery.documents).toHaveLength(0);
    expect(j.delivery.texts).toHaveLength(1); // figure-free hold message
    expect(j.audit.entries.some((e) => e.action === 'report_held')).toBe(true);
  });

  it('PROBE: a data-pull error → BLOCKED (retry message), distinct from FAIL', async () => {
    const j = job(new FakeClient({ get_receivables_summary: new Error('ledger unreachable') }));
    const res = await j.run({ type: 'receivables' });
    expect(res.verdict).toBe('BLOCKED');
    expect(res.delivered).toBe(false);
    expect(j.audit.entries.some((e) => e.action === 'report_blocked')).toBe(true);
  });

  it('statement for an unknown party is held with a name-confirm ask, not a PDF', async () => {
    const j = job(new FakeClient({ get_statement: { found: false, party: 'Nobody', lines: [], closing_balance_paisa: 0, line_count: 0 } }));
    const res = await j.run({ type: 'statement', party: 'Nobody' });
    expect(res.verdict).toBe('FAIL');
    expect(j.delivery.texts[0]).toMatch(/couldn't find|confirm the name/i);
  });
});
