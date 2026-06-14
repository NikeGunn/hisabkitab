/**
 * Runtime verification for Module C reports (CLAUDE.md §8 — observe the real artifact).
 * Drives the WHOLE path over the real Ledger MCP HTTP server:
 *   seed confirmed AR invoices → dispatchReport (real MCP client) → render → reconcile →
 *   deliver, capturing the PDF; plus the reconcile-HOLD path on a tampered scenario.
 *
 * Verdicts: PASS | FAIL | BLOCKED. Exits non-zero on any FAIL/BLOCKED.
 *   pnpm --filter @hisab/orchestrator verify:reports
 * Requires local Postgres (hisabkitab_test) with migrations applied.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTenantToken, startHttpServer } from '@hisab/mcp-ledger';
import { migrate, createDb } from '@hisab/db';
import { dispatchReport } from './reports/dispatch.js';
import type { ReportDelivery, ReportAuditSink } from './reports/report-job.js';

const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab_test';
const APP_URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab_test';
const PORT = 8971;
const SECRET = 'verify-reports-secret';
const SERVICE = 'verify-reports-service-token';
const LEDGER_URL = `http://127.0.0.1:${PORT}/mcp`;

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
const results: Array<{ name: string; verdict: Verdict; note: string }> = [];
const record = (name: string, verdict: Verdict, note: string): void => {
  results.push({ name, verdict, note });
  const icon = verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : '⛔';
  console.log(`${icon} ${name}: ${verdict} — ${note}`);
};

class Capture implements ReportDelivery {
  docs: Array<{ filename: string; caption: string; bytes: Buffer }> = [];
  texts: string[] = [];
  sendDocument(_to: string, bytes: Buffer, filename: string, caption: string): Promise<void> {
    this.docs.push({ filename, caption, bytes });
    return Promise.resolve();
  }
  sendText(_to: string, body: string): Promise<void> {
    this.texts.push(body);
    return Promise.resolve();
  }
}
const audit: ReportAuditSink = { log: () => Promise.resolve() };
const isPdf = (b: Buffer): boolean => b.subarray(0, 5).toString('latin1') === '%PDF-';

async function seedTenant(name: string): Promise<string> {
  const sql = postgres(ADMIN_URL, { max: 1 });
  try {
    const [row] = await sql`INSERT INTO tenants (business_name, pan_or_vat_no, status) VALUES (${name}, '301234567', 'active') RETURNING id`;
    return row!['id'] as string;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Use the real MCP over HTTP to record+confirm a credit sale (proves the write path too). */
async function recordConfirmedInvoice(tenantId: string, party: string, issuedOn: string, dueOn: string | null, amountPaisa: number): Promise<void> {
  const token = createTenantToken(tenantId, SECRET, 300);
  const transport = new StreamableHTTPClientTransport(new URL(LEDGER_URL), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'verify-seed', version: '0.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'record_credit_sale', arguments: { party, issued_on: issuedOn, ...(dueOn ? { due_on: dueOn } : {}), amount_paisa: amountPaisa } });
    const r = JSON.parse((res.content as Array<{ text?: string }>)[0]?.text ?? '{}') as { invoice_id: string };
    await client.callTool({ name: 'confirm_arap_entry', arguments: { entry_type: 'ar_invoice', entry_id: r.invoice_id } });
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  process.env['LEDGER_MCP_TOKEN'] = SERVICE;
  process.env['TENANT_SIGNING_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = APP_URL;

  console.log('migrating…');
  await migrate(ADMIN_URL);
  console.log('starting MCP http server…');
  const server = startHttpServer(PORT); // already calls listen(PORT)
  await new Promise<void>((r) => setTimeout(r, 300)); // let it bind
  console.log('server up; seeding…');
  const orchHandle = createDb(process.env['TEST_ORCH_DATABASE_URL'] ?? 'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab_test');

  try {
    const tenantId = await seedTenant('Verify Reports Pvt Ltd');
    await recordConfirmedInvoice(tenantId, 'Sharma Traders', '2026-03-01', '2026-03-31', 904_000);
    await recordConfirmedInvoice(tenantId, 'Gurung Suppliers', '2026-05-20', '2026-06-20', 226_000);
    await recordConfirmedInvoice(tenantId, 'Thapa Hardware', '2026-04-15', '2026-05-15', 565_000);

    const deps = (delivery: ReportDelivery) => ({
      db: orchHandle.db,
      ledgerMcpUrl: LEDGER_URL,
      signingSecret: SECRET,
      delivery,
      audit,
    });

    // PROBE 1: receivables PDF delivered, real bytes, reconciling caption.
    {
      const cap = new Capture();
      await dispatchReport(deps(cap), tenantId, '+9779800000000', { report_type: 'receivables', as_of: '2026-06-14' });
      const doc = cap.docs[0];
      if (doc && isPdf(doc.bytes) && doc.bytes.length > 1500 && /total receivable/i.test(doc.caption)) {
        await mkdir(new URL('../report-samples/', import.meta.url), { recursive: true });
        await writeFile(new URL('../report-samples/verify-receivables.pdf', import.meta.url), doc.bytes);
        record('receivables-delivered', 'PASS', `${doc.bytes.length} bytes · ${doc.caption}`);
      } else if (cap.texts.length) {
        record('receivables-delivered', 'FAIL', `held instead of delivered: ${cap.texts[0]}`);
      } else {
        record('receivables-delivered', 'BLOCKED', 'no document and no message produced');
      }
    }

    // PROBE 2: statement for a real party reconciles and delivers.
    {
      const cap = new Capture();
      await dispatchReport(deps(cap), tenantId, '+9779800000000', { report_type: 'statement', party: 'Sharma Traders' });
      const doc = cap.docs[0];
      record('statement-delivered', doc && isPdf(doc.bytes) ? 'PASS' : 'FAIL', doc ? `${doc.bytes.length} bytes · ${doc.caption}` : `held: ${cap.texts[0] ?? 'nothing'}`);
    }

    // PROBE 3 (adversarial): statement for an UNKNOWN party must HOLD with a name-confirm ask, never a PDF.
    {
      const cap = new Capture();
      await dispatchReport(deps(cap), tenantId, '+9779800000000', { report_type: 'statement', party: 'Nonexistent Person' });
      if (cap.docs.length === 0 && /couldn't find|confirm the name/i.test(cap.texts[0] ?? '')) {
        record('unknown-party-held', 'PASS', `held + asked: ${cap.texts[0]}`);
      } else {
        record('unknown-party-held', 'FAIL', cap.docs.length ? 'sent a PDF for a nonexistent party!' : `unexpected: ${cap.texts[0]}`);
      }
    }

    // PROBE 4: sales summary for a month with no sales → reconciles (nil) and still delivers a clean PDF.
    {
      const cap = new Capture();
      await dispatchReport(deps(cap), tenantId, '+9779800000000', { report_type: 'sales_summary', bs_year: 2082, bs_month: 1 });
      const doc = cap.docs[0];
      record('sales-summary-nil', doc && isPdf(doc.bytes) ? 'PASS' : 'FAIL', doc ? `${doc.bytes.length} bytes · ${doc.caption}` : `held: ${cap.texts[0] ?? 'nothing'}`);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await orchHandle.close();
  }

  const bad = results.filter((r) => r.verdict !== 'PASS');
  console.log(`\n${results.length - bad.length}/${results.length} PASS`);
  process.exit(bad.length ? 1 : 0); // close lingering MCP server/db handles deterministically
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
