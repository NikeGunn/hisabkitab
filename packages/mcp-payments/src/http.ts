/**
 * Payments HTTP entrypoint:
 *   POST /mcp                      — Streamable HTTP MCP (same dual auth as the
 *                                    ledger: vault bearer = signed tenant token,
 *                                    or service token + x-hisab-tenant)
 *   GET  /payments/khalti/return   — Khalti redirects the payer's browser here.
 *                                    UNAUTHENTICATED by nature, so it trusts
 *                                    NOTHING from the query string except pidx:
 *                                    the row is found by pidx and settled via a
 *                                    fresh server-side lookup (exactly-once).
 *                                    Runs as hisab_orch (cross-tenant by design,
 *                                    like the WhatsApp webhook).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@hisab/db';
import { verifyTenantToken, AuthError } from '@hisab/mcp-ledger';
import { buildPaymentsServer } from './server.js';
import { settlePayment } from './tools.js';
import { KhaltiClient } from './khalti.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export interface PaymentsHttpDeps {
  serviceToken: string;
  signingSecret: string;
  /** Tenant-scoped MCP runtime handle (hisab_app). */
  appDb: Db;
  /** Cross-tenant callback handle (hisab_orch). */
  orchDb: Db;
  khalti: KhaltiClient;
  returnUrl: string;
  websiteUrl: string;
  log?: (msg: string) => void;
}

export function buildPaymentsHttpServer(deps: PaymentsHttpDeps): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // ---- liveness/readiness probe (Docker/K8s, no auth, no DB call) ----------
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/livez')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'mcp-payments' }));
    }

    // ---- payer redirect from Khalti (GET, unauthenticated) -------------------
    if (req.method === 'GET' && url.pathname === '/payments/khalti/return') {
      const pidx = url.searchParams.get('pidx') ?? '';
      let body = 'Payment status could not be confirmed yet. The shop owner will verify it shortly.';
      if (pidx) {
        try {
          const [row] = await deps.orchDb.select().from(schema.payments).where(eq(schema.payments.pidx, pidx));
          if (row) {
            const outcome = await deps.orchDb.transaction((tx) => settlePayment({ khalti: deps.khalti }, tx, row));
            deps.log?.(`khalti return ${pidx}: ${JSON.stringify(outcome['status'])}`);
            body =
              outcome['status'] === 'completed'
                ? 'Payment received — thank you! 🙏 The shop has been notified.'
                : `Payment not completed (${String(outcome['gateway_status'] ?? outcome['status'])}).`;
          }
        } catch (err) {
          deps.log?.(`khalti return ${pidx} failed: ${String(err)}`);
        }
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<html><body><p>${body}</p></body></html>`);
    }

    // ---- MCP ------------------------------------------------------------------
    if (url.pathname !== '/mcp' || req.method !== 'POST') return deny(res, 404, 'not found');
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return deny(res, 401, 'missing bearer token');
    const bearer = auth.slice(7);
    let tenantId: string;
    try {
      tenantId = safeEqual(bearer, deps.serviceToken)
        ? verifyTenantToken(String(req.headers['x-hisab-tenant'] ?? ''), deps.signingSecret)
        : verifyTenantToken(bearer, deps.signingSecret);
    } catch (err) {
      return deny(res, 401, err instanceof AuthError ? err.message : 'invalid bearer token');
    }
    try {
      const server = buildPaymentsServer({
        db: deps.appDb,
        tenantId,
        khalti: deps.khalti,
        returnUrl: deps.returnUrl,
        websiteUrl: deps.websiteUrl,
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      if (!res.headersSent) deny(res, 500, err instanceof Error ? err.message : 'internal error');
    }
  });
}

// `pathToFileURL` is correct on both Windows and Linux (see ledger http.ts).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const port = Number(process.env['PORT'] ?? 8802);
  const publicBase = process.env['PAYMENTS_PUBLIC_BASE_URL'] ?? `http://localhost:${port}`;
  const httpServer = buildPaymentsHttpServer({
    serviceToken: requireEnv('PAYMENTS_MCP_TOKEN'),
    signingSecret: requireEnv('TENANT_SIGNING_SECRET'),
    appDb: createDb(requireEnv('DATABASE_URL')).db,
    orchDb: createDb(requireEnv('CALLBACK_DATABASE_URL')).db,
    khalti: new KhaltiClient({
      secretKey: requireEnv('KHALTI_SECRET_KEY'),
      ...(process.env['KHALTI_ORIGIN'] ? { origin: process.env['KHALTI_ORIGIN'] } : {}),
    }),
    returnUrl: `${publicBase}/payments/khalti/return`,
    websiteUrl: process.env['WEBSITE_URL'] ?? 'https://hisabkitab.example',
    log: (m) => console.log(`[payments] ${m}`),
  });
  httpServer.listen(port, () => console.log(`hisab-payments listening on :${port} (/mcp + /payments/khalti/return)`));
}
