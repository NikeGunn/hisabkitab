/**
 * Report generation job (PRD v1.2 §C4.2 + §C9). The end-to-end deterministic flow:
 *   1. pull validated data via the Ledger read tools (buildReport),
 *   2. reconcile-or-hold: row sums == report total, aging buckets == total (in buildReport),
 *   3. render the PDF deterministically (PdfmakeRenderer) — model numbers only,
 *   4. re-verify the rendered artifact is non-empty and the reconcile verdict held,
 *   5. Pre-delivery Audit Gate: PASS → deliver as a WhatsApp document; FAIL/BLOCKED →
 *      HOLD, send a figure-free message asking the owner, log the decision.
 *
 * Verdict taxonomy (CLAUDE.md §8): PASS | FAIL | BLOCKED. When in doubt, never PASS —
 * a held report just costs one more look; a wrong one ships a bad number to a business.
 * No Anthropic/agent spend here: the agent only chooses the report; this job is mechanical.
 */
import { buildReport, type LedgerReadClient, type ReportBuildResult, type ReportRequest, type TenantInfo } from './report-data.js';
import { PdfmakeRenderer, type PdfRenderer } from './render.js';

export type ReportVerdict = 'PASS' | 'FAIL' | 'BLOCKED';

export interface ReportDelivery {
  /** send a document (PDF) on the open 24h window. */
  sendDocument(to: string, bytes: Buffer, filename: string, caption: string): Promise<void>;
  /** figure-free hold message when a report cannot be reconciled. */
  sendText(to: string, body: string): Promise<void>;
}

export interface ReportAuditSink {
  log(entry: { tenantId: string; action: string; detail: Record<string, unknown> }): Promise<void>;
}

export interface ReportJobDeps {
  client: LedgerReadClient;
  renderer?: PdfRenderer;
  delivery: ReportDelivery;
  audit: ReportAuditSink;
}

export interface ReportJobInput {
  tenantId: string;
  toE164: string;
  tenant: TenantInfo;
  request: ReportRequest;
}

export interface ReportJobResult {
  verdict: ReportVerdict;
  delivered: boolean;
  reportType: string;
  summaryLine: string;
  checks: ReportBuildResult['checks'];
  pdfBytes?: number;
}

const FILENAME: Record<string, string> = {
  receivables: 'Receivables-Debtors',
  payables: 'Payables-Creditors',
  statement: 'Statement-of-Account',
  sales_summary: 'Sales-Summary',
};

export async function runReportJob(deps: ReportJobDeps, input: ReportJobInput): Promise<ReportJobResult> {
  const renderer = deps.renderer ?? new PdfmakeRenderer();
  const { tenantId, toE164, tenant, request } = input;

  let built: ReportBuildResult;
  try {
    built = await buildReport(deps.client, tenant, request);
  } catch (err) {
    // Couldn't even pull/compute → BLOCKED (could not observe), not FAIL (observed-wrong).
    const detail = err instanceof Error ? err.message : String(err);
    await deps.audit.log({ tenantId, action: 'report_blocked', detail: { request, error: detail } });
    await deps.delivery.sendText(toE164, "I couldn't pull the figures for that report just now — let me try again shortly, or tell me which report you'd like.");
    return { verdict: 'BLOCKED', delivered: false, reportType: request.type, summaryLine: detail, checks: [] };
  }

  // reconcile-or-hold: a report whose totals don't tie is FAILED and never sent.
  if (!built.reconciled) {
    await deps.audit.log({ tenantId, action: 'report_held', detail: { request, checks: built.checks } });
    await deps.delivery.sendText(toE164, built.summaryLine);
    return { verdict: 'FAIL', delivered: false, reportType: request.type, summaryLine: built.summaryLine, checks: built.checks };
  }

  // render deterministically, then re-verify the artifact actually has bytes.
  let pdf: Buffer;
  try {
    pdf = await renderer.render(built.model);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await deps.audit.log({ tenantId, action: 'report_blocked', detail: { request, error: `render failed: ${detail}` } });
    await deps.delivery.sendText(toE164, "I prepared your numbers but hit a snag making the PDF — I'll retry shortly.");
    return { verdict: 'BLOCKED', delivered: false, reportType: request.type, summaryLine: detail, checks: built.checks };
  }
  if (pdf.length === 0 || !isPdf(pdf)) {
    await deps.audit.log({ tenantId, action: 'report_blocked', detail: { request, error: 'empty or non-PDF render output' } });
    await deps.delivery.sendText(toE164, "I couldn't produce a valid PDF for that report — let me retry.");
    return { verdict: 'BLOCKED', delivered: false, reportType: request.type, summaryLine: 'empty render', checks: built.checks };
  }

  const filename = `${FILENAME[request.type] ?? 'Report'}-${dateStamp()}.pdf`;
  await deps.delivery.sendDocument(toE164, pdf, filename, built.summaryLine);
  await deps.audit.log({
    tenantId,
    action: 'report_delivered',
    detail: { request, filename, bytes: pdf.length, checks: built.checks, summaryLine: built.summaryLine },
  });
  return {
    verdict: 'PASS',
    delivered: true,
    reportType: request.type,
    summaryLine: built.summaryLine,
    checks: built.checks,
    pdfBytes: pdf.length,
  };
}

/** %PDF- magic bytes — the cheapest proof the artifact is a real PDF. */
function isPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
