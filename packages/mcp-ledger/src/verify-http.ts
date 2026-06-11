/**
 * Runtime verification (CLAUDE.md §8) of the REAL HTTP artifact — `pnpm verify`:
 * boots the server, connects a real MCP client over Streamable HTTP with signed
 * headers, calls a tool, and probes that bad service/tenant tokens are rejected.
 * Verdicts: PASS | FAIL | BLOCKED; exit non-zero on FAIL or BLOCKED.
 */
import postgres from 'postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from './http.js';
import { createTenantToken } from './auth.js';

const PORT = 8899;
const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;
const SERVICE_TOKEN = 'verify-service-token';
const SIGNING_SECRET = 'verify-signing-secret';
const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab';

process.env['LEDGER_MCP_TOKEN'] = SERVICE_TOKEN;
process.env['TENANT_SIGNING_SECRET'] = SIGNING_SECRET;
process.env['DATABASE_URL'] ??= 'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab';

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
const results: Array<{ name: string; verdict: Verdict; detail: string }> = [];
const record = (name: string, verdict: Verdict, detail: string) => {
  results.push({ name, verdict, detail });
  console.log(`[${verdict}] ${name}\n       ${detail}\n`);
};

async function ensureTenant(): Promise<string> {
  const sql = postgres(ADMIN_URL, { max: 1 });
  try {
    const [row] = await sql`
      INSERT INTO tenants (business_name, pan_or_vat_no, status)
      VALUES ('Verify Pasal', '300000001', 'active')
      ON CONFLICT DO NOTHING RETURNING id`;
    if (row) return row['id'] as string;
    const [existing] = await sql`SELECT id FROM tenants WHERE business_name = 'Verify Pasal' LIMIT 1`;
    return existing!['id'] as string;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function postRaw(headers: Record<string, string>): Promise<number> {
  const res = await fetch(URL_MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
  });
  await res.text();
  return res.status;
}

async function main(): Promise<void> {
  const tenantId = await ensureTenant();
  const httpServer = startHttpServer(PORT);
  try {
    // happy path: real client, real HTTP, signed tenant metadata
    try {
      const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
        requestInit: {
          headers: {
            authorization: `Bearer ${SERVICE_TOKEN}`,
            'x-hisab-tenant': createTenantToken(tenantId, SIGNING_SECRET),
          },
        },
      });
      const client = new Client({ name: 'verify-http', version: '0.0.0' });
      await client.connect(transport);
      const res = await client.callTool({ name: 'compute_vat', arguments: { amount_paisa: 904000, inclusive: true } });
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
      const parsed = JSON.parse(text) as { excl_paisa: number; vat_paisa: number };
      if (parsed.excl_paisa === 800000 && parsed.vat_paisa === 104000) {
        record('HTTP round-trip: compute_vat over Streamable HTTP', 'PASS', `server returned ${text}`);
      } else {
        record('HTTP round-trip: compute_vat over Streamable HTTP', 'FAIL', `unexpected result ${text}`);
      }
      await client.close();
    } catch (err) {
      record('HTTP round-trip: compute_vat over Streamable HTTP', 'BLOCKED', String(err));
    }

    // probes: every auth lie must bounce with 401
    const probes: Array<[string, Record<string, string>]> = [
      ['PROBE: wrong service token rejected', { authorization: 'Bearer wrong', 'x-hisab-tenant': createTenantToken(tenantId, SIGNING_SECRET) }],
      ['PROBE: missing tenant token rejected', { authorization: `Bearer ${SERVICE_TOKEN}` }],
      ['PROBE: tenant token signed with WRONG secret rejected', { authorization: `Bearer ${SERVICE_TOKEN}`, 'x-hisab-tenant': createTenantToken(tenantId, 'attacker-secret') }],
    ];
    for (const [name, headers] of probes) {
      try {
        const status = await postRaw(headers);
        record(name, status === 401 ? 'PASS' : 'FAIL', `HTTP ${status}`);
      } catch (err) {
        record(name, 'BLOCKED', String(err));
      }
    }
  } finally {
    httpServer.close();
  }

  const bad = results.filter((r) => r.verdict !== 'PASS').length;
  console.log(`${results.length} checks: ${results.length - bad} PASS, ${bad} not-PASS`);
  process.exitCode = bad > 0 ? 1 : 0;
}

void main();
