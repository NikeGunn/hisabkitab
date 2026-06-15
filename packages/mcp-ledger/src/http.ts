/**
 * Remote MCP entrypoint (Streamable HTTP, stateless mode — one server per request,
 * which also guarantees per-request tenant scoping).
 *
 * Auth — two accepted shapes:
 *   (a) Authorization: Bearer <signed tenant token>      — what Managed Agents vaults
 *       inject (a vault credential can only set the Authorization header); the token
 *       itself is HMAC-signed tenant session metadata, so it authenticates AND scopes.
 *   (b) Authorization: Bearer ${LEDGER_MCP_TOKEN} + x-hisab-tenant: <signed token>
 *       — service-token shape for first-party callers/tests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'node:crypto';
import { createDb } from '@hisab/db';
import { buildLedgerServer } from './server.js';
import { verifyTenantToken, AuthError } from './auth.js';

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

export function startHttpServer(port: number): ReturnType<typeof createServer> {
  const serviceToken = requireEnv('LEDGER_MCP_TOKEN');
  const signingSecret = requireEnv('TENANT_SIGNING_SECRET');
  const { db } = createDb(requireEnv('DATABASE_URL'));

  const httpServer = createServer(async (req, res) => {
    // Liveness/readiness probe (Docker/K8s). No auth, no DB call — a liveness
    // check must not flap on a transient DB blip; the LB gates real traffic.
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/livez')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'mcp-ledger' }));
    }
    if (req.url !== '/mcp' || req.method !== 'POST') return deny(res, 404, 'not found');
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return deny(res, 401, 'missing bearer token');
    const bearer = auth.slice(7);
    let tenantId: string;
    if (safeEqual(bearer, serviceToken)) {
      // shape (b): service token + tenant header
      try {
        tenantId = verifyTenantToken(String(req.headers['x-hisab-tenant'] ?? ''), signingSecret);
      } catch (err) {
        return deny(res, 401, err instanceof AuthError ? err.message : 'invalid tenant token');
      }
    } else {
      // shape (a): the bearer IS the signed tenant token (vault-injected)
      try {
        tenantId = verifyTenantToken(bearer, signingSecret);
      } catch (err) {
        return deny(res, 401, err instanceof AuthError ? err.message : 'invalid bearer token');
      }
    }
    try {
      const server = buildLedgerServer({ db }, tenantId);
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

  httpServer.listen(port, () => console.log(`hisab-ledger MCP listening on :${port}/mcp`));
  return httpServer;
}

// `pathToFileURL` is correct on both Windows and Linux (the old hand-built
// `file:///${path}` produced four slashes on Linux → never matched in a container).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) startHttpServer(Number(process.env['PORT'] ?? 8801));
