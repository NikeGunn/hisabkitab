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
import { createDb, schema, SettingsCache, type Db } from '@hisab/db';
import { MetricsRegistry, bindMetrics, metricsResponse, createLogger } from '@hisab/shared';
import { verifyTenantToken, AuthError, type TenantSession } from '@hisab/mcp-ledger';
import { buildPaymentsServer } from './server.js';
import { settlePayment } from './tools.js';
import { settleSubscriptionPayment } from './billing.js';
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
  /** A client, or a getter re-read per request (runtime settings: key/environment swap). */
  khalti: KhaltiClient | (() => KhaltiClient);
  returnUrl: string;
  websiteUrl: string;
  /** Subscription billing live? Omitted/false = dev mode (no charge). Getter = runtime setting. */
  live?: boolean | (() => boolean);
  log?: (msg: string) => void;
}

export function buildPaymentsHttpServer(deps: PaymentsHttpDeps): ReturnType<typeof createServer> {
  // Per-instance observability (one registry per server; tests get isolated ones).
  const metricsRegistry = new MetricsRegistry();
  const metrics = bindMetrics(metricsRegistry);
  const log = createLogger('mcp-payments');

  const khalti = (): KhaltiClient => (typeof deps.khalti === 'function' ? deps.khalti() : deps.khalti);
  const live = (): boolean | undefined => (typeof deps.live === 'function' ? deps.live() : deps.live);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // ---- payment-link redirect (GET, unauthenticated) --------------------------
    // The `payment_link` WhatsApp template's button points HERE, not at Khalti, so
    // one approved template works for sandbox and production. Only an `initiated`
    // subscription payment redirects, and only to a Khalti-hosted checkout URL.
    // Public URL is api…/payments/go/<pidx>; Caddy strips the /payments prefix, so
    // the service sees /go/<pidx> (direct hits keep the prefix).
    const go = /^(?:\/payments)?\/go\/([A-Za-z0-9_-]{6,64})$/.exec(url.pathname);
    if (req.method === 'GET' && go) {
      const [row] = await deps.orchDb
        .select({ status: schema.billingPayments.status, paymentUrl: schema.billingPayments.paymentUrl })
        .from(schema.billingPayments)
        .where(eq(schema.billingPayments.pidx, go[1]!));
      const target = row?.paymentUrl ? safeKhaltiUrl(row.paymentUrl) : null;
      if (row?.status === 'initiated' && target) {
        res.writeHead(302, { location: target, 'cache-control': 'no-store' });
        return res.end();
      }
      res.writeHead(row ? 410 : 404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        page(
          row?.status === 'completed'
            ? 'This payment is already complete. Thank you! 🙏'
            : 'This payment link has expired or is not valid. Reply "renew" to HisabKitab on WhatsApp for a new one.',
        ),
      );
    }

    // ---- liveness/readiness probe (Docker/K8s, no auth, no DB call) ----------
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/livez')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'mcp-payments' }));
    }

    // ---- Prometheus scrape (P14 §8, aggregate only, no auth) ------------------
    if (req.method === 'GET' && url.pathname === '/metrics') {
      const m = metricsResponse(metricsRegistry);
      res.writeHead(m.status, { 'content-type': m.contentType });
      return res.end(m.body);
    }

    // ---- payer redirect from Khalti (GET, unauthenticated) -------------------
    if (req.method === 'GET' && url.pathname === '/payments/khalti/return') {
      const pidx = url.searchParams.get('pidx') ?? '';
      let body =
        'Payment status could not be confirmed yet. The shop owner will verify it shortly.';
      if (pidx) {
        try {
          // A pidx is either a customer COLLECTION (payments → a sale) or a
          // SUBSCRIPTION payment (billing_payments → extends the period). Try
          // collection first, then subscription. Both settle by lookup, exactly-once.
          const [coll] = await deps.orchDb
            .select()
            .from(schema.payments)
            .where(eq(schema.payments.pidx, pidx));
          const [bill] = coll
            ? [undefined]
            : await deps.orchDb
                .select()
                .from(schema.billingPayments)
                .where(eq(schema.billingPayments.pidx, pidx));
          if (coll) {
            const outcome = await deps.orchDb.transaction((tx) =>
              settlePayment({ khalti: khalti() }, tx, coll),
            );
            metrics.gateway({ target: 'khalti', result: 'ok' });
            log.info('khalti return settled', {
              kind: 'collection',
              status: String(outcome['status']),
            });
            deps.log?.(`khalti return (collection) ${pidx}: ${JSON.stringify(outcome['status'])}`);
            body =
              outcome['status'] === 'completed'
                ? 'Payment received — thank you! 🙏 The shop has been notified.'
                : `Payment not completed (${String(outcome['gateway_status'] ?? outcome['status'])}).`;
          } else if (bill) {
            const outcome = await deps.orchDb.transaction((tx) =>
              settleSubscriptionPayment({ khalti: khalti() }, tx, bill),
            );
            metrics.gateway({ target: 'khalti', result: 'ok' });
            log.info('khalti return settled', {
              kind: 'subscription',
              status: String(outcome['status']),
            });
            deps.log?.(
              `khalti return (subscription) ${pidx}: ${JSON.stringify(outcome['status'])}`,
            );
            body =
              outcome['status'] === 'completed'
                ? 'Subscription payment received — thank you! 🙏 Your HisabKitab plan is active.'
                : `Payment not completed (${String(outcome['gateway_status'] ?? outcome['status'])}).`;
          }
        } catch (err) {
          metrics.gateway({ target: 'khalti', result: 'error' });
          metrics.error({ component: 'khalti-return' });
          log.error('khalti return failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          deps.log?.(`khalti return ${pidx} failed: ${String(err)}`);
        }
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(body));
    }

    // ---- MCP ------------------------------------------------------------------
    if (url.pathname !== '/mcp' || req.method !== 'POST') return deny(res, 404, 'not found');
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return deny(res, 401, 'missing bearer token');
    const bearer = auth.slice(7);
    let session: TenantSession;
    try {
      session = safeEqual(bearer, deps.serviceToken)
        ? verifyTenantToken(String(req.headers['x-hisab-tenant'] ?? ''), deps.signingSecret)
        : verifyTenantToken(bearer, deps.signingSecret);
    } catch (err) {
      return deny(res, 401, err instanceof AuthError ? err.message : 'invalid bearer token');
    }
    try {
      const server = buildPaymentsServer({
        db: deps.appDb,
        tenantId: session.tenantId,
        role: session.role,
        khalti: khalti(),
        returnUrl: deps.returnUrl,
        websiteUrl: deps.websiteUrl,
        ...(live() !== undefined ? { live: live() as boolean } : {}),
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      metrics.error({ component: 'payments-mcp' });
      log.error('mcp request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) deny(res, 500, err instanceof Error ? err.message : 'internal error');
    }
  });
}

/** Only ever redirect to a Khalti-hosted checkout (defence against a tampered row). */
export function safeKhaltiUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const khaltiHost = host === 'khalti.com' || host.endsWith('.khalti.com');
    return u.protocol === 'https:' && khaltiHost ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Minimal branded result page for the browser-facing endpoints. */
function page(message: string): string {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HisabKitab</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#faf7f2;color:#1c1917;display:grid;place-items:center;min-height:100vh}main{max-width:420px;margin:16px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 1px 3px #0001;text-align:center}h1{font-size:18px;margin:0 0 12px;color:#c2410c}p{line-height:1.5}</style></head><body><main><h1>HisabKitab</h1><p>${esc}</p><p><a href="https://hisabkitab.pro">hisabkitab.pro</a></p></main></body></html>`;
}

// `pathToFileURL` is correct on both Windows and Linux (see ledger http.ts).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const port = Number(process.env['PORT'] ?? 8802);
  const publicBase = process.env['PAYMENTS_PUBLIC_BASE_URL'] ?? `http://localhost:${port}`;
  const orchDb = createDb(requireEnv('CALLBACK_DATABASE_URL')).db;
  // Khalti key / environment / live flag are RUNTIME settings (admin panel), with
  // env as the default — switching sandbox→production is a settings change, not a
  // deploy. The client is rebuilt only when the key or origin actually changes.
  // Lenient start: /healthz must not depend on the DB, but no Khalti call is made
  // until the admin settings have actually loaded (never a silent env fallback).
  const settings = new SettingsCache(orchDb, process.env, (err) =>
    createLogger('mcp-payments').error('settings refresh failed', { error: String(err) }),
  ).startLenient(10_000);
  let cached: { sig: string; client: KhaltiClient } | undefined;
  const khaltiFromSettings = (): KhaltiClient => {
    if (!settings.ready) throw new Error('payment settings are not loaded yet; try again in a few seconds');
    const secretKey = settings.require('khalti.secret_key');
    const origin = settings.require('khalti.origin');
    const sig = `${origin}|${secretKey}`;
    if (cached?.sig !== sig) cached = { sig, client: new KhaltiClient({ secretKey, origin }) };
    return cached.client;
  };
  const httpServer = buildPaymentsHttpServer({
    serviceToken: requireEnv('PAYMENTS_MCP_TOKEN'),
    signingSecret: requireEnv('TENANT_SIGNING_SECRET'),
    appDb: createDb(requireEnv('DATABASE_URL')).db,
    orchDb,
    khalti: khaltiFromSettings,
    returnUrl: `${publicBase}/payments/khalti/return`,
    websiteUrl: process.env['WEBSITE_URL'] ?? 'https://hisabkitab.example',
    // Subscription billing stays in DEV mode unless switched on (setting payments.live).
    live: () => settings.ready && settings.bool('payments.live'),
    log: (m) => console.log(`[payments] ${m}`),
  });
  httpServer.listen(port, () =>
    createLogger('mcp-payments').info('mcp-payments listening', {
      port,
      endpoints: ['/mcp', '/payments/khalti/return', '/healthz', '/metrics'],
    }),
  );
}
