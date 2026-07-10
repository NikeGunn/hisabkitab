/**
 * Tally MCP + connector API entrypoint.
 *
 *   POST /mcp               — Streamable HTTP MCP (same dual auth as ledger/payments:
 *                             vault-injected signed tenant token, or service token +
 *                             x-hisab-tenant header). Tenant-scoped hisab_app handle.
 *   POST /connector/register — customer connector swaps a one-time setup code for a
 *                             device token (cross-tenant hisab_orch handle).
 *   POST /connector/claim   — long-poll for the connector's next job (device token).
 *   POST /connector/result  — post a job result (device token; 1 MB cap; validated).
 *   GET  /healthz, /livez, /metrics — same conventions as every other service.
 *
 * The connector endpoints NEVER accept an operation name or raw query from the wire
 * as something to execute — claim only hands out server-created, allowlisted jobs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDb } from '@hisab/db';
import {
  MetricsRegistry,
  bindMetrics,
  metricsResponse,
  createLogger,
  type Logger,
} from '@hisab/shared';
import { verifyTenantToken, AuthError, type TenantSession } from '@hisab/mcp-ledger';
import { buildTallyServer } from './server.js';
import { authConnector, claimJob, postResult, registerConnector } from './connector-api.js';

const metricsRegistry = new MetricsRegistry();
const metrics = bindMetrics(metricsRegistry);
const log: Logger = createLogger('mcp-tally');

/** Connector results can list many bills; cap the body well below Postgres comfort. */
const MAX_CONNECTOR_BODY_BYTES = 1_000_000;
/** Server-side long-poll bound for /connector/claim. */
const CLAIM_WAIT_MS = 20_000;

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

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function deny(res: ServerResponse, status: number, message: string): void {
  json(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export function startHttpServer(port: number): ReturnType<typeof createServer> {
  const serviceToken = requireEnv('TALLY_MCP_TOKEN');
  const signingSecret = requireEnv('TENANT_SIGNING_SECRET');
  // Tool side: tenant-scoped RLS role. Connector side: cross-tenant (device-token auth),
  // the same split as payments (DATABASE_URL app + CALLBACK_DATABASE_URL orch).
  const { db } = createDb(requireEnv('DATABASE_URL'));
  const { db: orchDb } = createDb(requireEnv('CONNECTOR_DATABASE_URL'));

  const httpServer = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/livez')) {
        return json(res, 200, { ok: true, service: 'mcp-tally' });
      }
      if (req.method === 'GET' && req.url === '/metrics') {
        const m = metricsResponse(metricsRegistry);
        res.writeHead(m.status, { 'content-type': m.contentType });
        return res.end(m.body);
      }

      // ---- connector API (device-token world; no tenant tokens here) -----------
      if (req.method === 'POST' && req.url === '/connector/register') {
        const body = (await readJson(req, 10_000)) as
          | { setup_code?: string; connector_version?: string }
          | undefined;
        if (!body?.setup_code) return json(res, 400, { error: 'setup_code required' });
        const out = await registerConnector(orchDb, {
          setup_code: body.setup_code,
          ...(body.connector_version ? { connector_version: body.connector_version } : {}),
        });
        if (out.kind !== 'registered') {
          metrics.error({ component: 'tally-connector-register' });
          log.warn('connector registration rejected');
          return json(res, 403, { error: 'invalid or expired setup code' });
        }
        log.info('connector registered', { connector_id: out.connectorId });
        return json(res, 200, {
          connector_id: out.connectorId,
          connector_token: out.connectorToken,
          poll_hint_ms: 1_000,
        });
      }
      if (
        req.method === 'POST' &&
        (req.url === '/connector/claim' || req.url === '/connector/result')
      ) {
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ')) return json(res, 401, { error: 'missing bearer token' });
        const version =
          typeof req.headers['x-connector-version'] === 'string'
            ? req.headers['x-connector-version']
            : undefined;
        const connector = await authConnector(orchDb, auth.slice(7), version);
        if (!connector) return json(res, 401, { error: 'unknown or revoked connector token' });

        if (req.url === '/connector/claim') {
          const job = await claimJob(orchDb, connector.id, CLAIM_WAIT_MS);
          return json(res, 200, { job });
        }
        const body = (await readJson(req, MAX_CONNECTOR_BODY_BYTES)) as
          | { job_id?: string; envelope?: unknown }
          | undefined;
        if (!body?.job_id) return json(res, 400, { error: 'job_id required' });
        const stored = await postResult(orchDb, connector.id, body.job_id, body.envelope);
        if (stored !== 'stored') return json(res, 409, { error: 'job not accepting a result' });
        return json(res, 200, { ok: true });
      }

      // ---- MCP (tenant-token world) --------------------------------------------
      if (req.url !== '/mcp' || req.method !== 'POST') return deny(res, 404, 'not found');
      const correlationId = String(req.headers['x-correlation-id'] ?? '');
      const reqLog = correlationId ? log.child({ correlation_id: correlationId }) : log;
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) return deny(res, 401, 'missing bearer token');
      const bearer = auth.slice(7);
      let session: TenantSession;
      try {
        session = safeEqual(bearer, serviceToken)
          ? verifyTenantToken(String(req.headers['x-hisab-tenant'] ?? ''), signingSecret)
          : verifyTenantToken(bearer, signingSecret);
      } catch (err) {
        return deny(res, 401, err instanceof AuthError ? err.message : 'invalid bearer token');
      }
      try {
        const server = buildTallyServer(
          { db, ...(correlationId ? { correlationId } : {}) },
          session,
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, await readJson(req, MAX_CONNECTOR_BODY_BYTES));
      } catch (err) {
        metrics.error({ component: 'tally-mcp' });
        reqLog.error('mcp request failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) deny(res, 500, err instanceof Error ? err.message : 'internal error');
      }
    } catch (err) {
      metrics.error({ component: 'tally-http' });
      log.error('request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) json(res, 400, { error: 'bad request' });
    }
  });

  httpServer.listen(port, () =>
    log.info('mcp-tally listening', {
      port,
      endpoints: ['/mcp', '/connector/*', '/healthz', '/metrics'],
    }),
  );
  return httpServer;
}

// `pathToFileURL` is correct on both Windows and Linux (see CLAUDE.md §4a gotcha).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) startHttpServer(Number(process.env['PORT'] ?? 8803));
