/**
 * Generate sample report PDFs to ./report-samples/ so the output can be eyeballed.
 *   pnpm --filter @hisab/orchestrator exec tsx src/reports/sample.ts
 * Uses static validated fixtures (no DB, no API) — purely exercises the renderer.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { buildReport, type LedgerReadClient } from './report-data.js';
import { PdfmakeRenderer } from './render.js';

const TENANT = { businessName: 'Everest Buildcon Pvt Ltd', panOrVatNo: '301234567' };

const fixtures: Record<string, unknown> = {
  get_receivables_summary: {
    as_of: '2026-06-14',
    reconciled: true,
    rows: [
      { party: 'Sharma Traders', ref: 'INV-1042', dated_on: '2026-03-01', due_on: '2026-03-31', total_paisa: 904_000, paid_paisa: 0, balance_paisa: 904_000, days_overdue: 75 },
      { party: 'Gurung Suppliers', ref: 'INV-1051', dated_on: '2026-05-20', due_on: '2026-06-20', total_paisa: 226_000, paid_paisa: 100_000, balance_paisa: 126_000, days_overdue: 0 },
      { party: 'Thapa Hardware', ref: 'INV-1060', dated_on: '2026-04-15', due_on: '2026-05-15', total_paisa: 565_000, paid_paisa: 0, balance_paisa: 565_000, days_overdue: 30 },
      { party: 'Newa Enterprises', ref: 'INV-1063', dated_on: '2026-02-01', due_on: null, total_paisa: 339_000, paid_paisa: 0, balance_paisa: 339_000, days_overdue: 0 },
    ],
    aging: { current_paisa: 126_000, days1to30_paisa: 565_000, days31to60_paisa: 0, days61to90_paisa: 904_000, days90plus_paisa: 0, no_due_date_paisa: 339_000 },
    total_paisa: 1_934_000,
  },
  get_statement: {
    found: true,
    party: 'Sharma Traders',
    lines: [
      { date: '2026-03-01', kind: 'invoice', ref: 'INV-1042', debit_paisa: 904_000, credit_paisa: 0, running_balance_paisa: 904_000 },
      { date: '2026-03-20', kind: 'payment received', ref: null, debit_paisa: 0, credit_paisa: 400_000, running_balance_paisa: 504_000 },
      { date: '2026-04-10', kind: 'invoice', ref: 'INV-1055', debit_paisa: 565_000, credit_paisa: 0, running_balance_paisa: 1_069_000 },
    ],
    closing_balance_paisa: 1_069_000,
    line_count: 3,
  },
  get_sales_summary: { bs_year: 2082, bs_month: 2, net_paisa: 4_500_000, vat_paisa: 585_000, gross_paisa: 5_085_000, count: 23 },
};

class FixtureClient implements LedgerReadClient {
  call<T>(name: string): Promise<T> {
    return Promise.resolve(fixtures[name] as T);
  }
}

async function main(): Promise<void> {
  const dir = new URL('../../report-samples/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const client = new FixtureClient();
  const renderer = new PdfmakeRenderer();
  const reqs = [
    { type: 'receivables' as const, file: 'receivables.pdf' },
    { type: 'statement' as const, party: 'Sharma Traders', file: 'statement.pdf' },
    { type: 'sales_summary' as const, bsYear: 2082, bsMonth: 2, file: 'sales-summary.pdf' },
  ];
  for (const { file, ...req } of reqs) {
    const built = await buildReport(client, TENANT, req);
    const pdf = await renderer.render(built.model);
    await writeFile(new URL(file, dir), pdf);
    console.log(`${file}: ${pdf.length} bytes · reconciled=${built.reconciled} · ${built.summaryLine}`);
  }
  console.log(`\nWrote samples to ${dir.pathname}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
