/**
 * Wire a captured report request to the deterministic report job, over the REAL Ledger
 * MCP (a fresh signed tenant token per call — same bearer the vault injects). Pulls the
 * tenant's business name + PAN for the report header, then runs render→reconcile→deliver.
 * No Anthropic/agent spend — purely mechanical (PRD §C4.1 determinism).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTenantToken } from '@hisab/mcp-ledger';
import { decPII, schema, withTenant, type Db } from '@hisab/db';
import { eq } from 'drizzle-orm';
import { runReportJob, type ReportAuditSink, type ReportDelivery } from './report-job.js';
import type { LedgerReadClient } from './report-data.js';
import type { CapturedReportRequest } from '../session/client.js';

export interface ReportDispatchDeps {
  db: Db;
  ledgerMcpUrl: string;
  signingSecret: string;
  delivery: ReportDelivery;
  audit: ReportAuditSink;
  ttlSeconds?: number;
  log?: (msg: string) => void;
}

/** A LedgerReadClient backed by a short-lived MCP client over Streamable HTTP. */
function mcpReadClient(transport: StreamableHTTPClientTransport, client: Client): LedgerReadClient {
  return {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '{}';
      if (res.isError) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text) as T;
    },
  };
  void transport;
}

export async function dispatchReport(
  deps: ReportDispatchDeps,
  tenantId: string,
  toE164: string,
  req: CapturedReportRequest,
): Promise<void> {
  const tenant = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ businessName: schema.tenants.businessName, panOrVatNo: schema.tenants.panOrVatNo })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    // PAN/VAT may be field-encrypted at rest (§9) — decrypt for the report header.
    return row ? { ...row, panOrVatNo: decPII(row.panOrVatNo) ?? '' } : row;
  });
  if (!tenant) {
    deps.log?.(`report dispatch: tenant ${tenantId} not found`);
    return;
  }

  const token = createTenantToken(tenantId, deps.signingSecret, deps.ttlSeconds ?? 300);
  const transport = new StreamableHTTPClientTransport(new URL(deps.ledgerMcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'hisab-reports', version: '0.0.0' });
  await client.connect(transport);
  try {
    const result = await runReportJob(
      { client: mcpReadClient(transport, client), delivery: deps.delivery, audit: deps.audit },
      {
        tenantId,
        toE164,
        tenant,
        request: {
          type: req.report_type,
          ...(req.party ? { party: req.party } : {}),
          ...(req.as_of ? { asOf: req.as_of } : {}),
          ...(req.bs_year !== undefined ? { bsYear: req.bs_year } : {}),
          ...(req.bs_month !== undefined ? { bsMonth: req.bs_month } : {}),
        },
      },
    );
    deps.log?.(`report ${req.report_type} for ${tenantId}: ${result.verdict} (delivered=${result.delivered})`);
  } finally {
    await client.close();
  }
}
