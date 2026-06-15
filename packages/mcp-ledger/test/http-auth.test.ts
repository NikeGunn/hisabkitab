/**
 * HTTP auth shapes on the real server (no DB writes — initialize only):
 *   (a) bearer = signed tenant token (what a Managed Agents vault injects)
 *   (b) bearer = service token + x-hisab-tenant header
 * PROBES: garbage bearer, service token without tenant header → 401.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startHttpServer } from '../src/http.js';
import { createTenantToken } from '../src/auth.js';
import { APP_URL } from './urls.js';

const PORT = 8898;
const SECRET = 'http-auth-test-secret';
const SERVICE = 'http-auth-test-service-token';
const TENANT = '3f2c9b1a-5d4e-4f6a-8b7c-9d0e1f2a3b4c';

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'http-auth-test', version: '0.0.0' },
  },
});

let server: Server;

beforeAll(() => {
  process.env['LEDGER_MCP_TOKEN'] = SERVICE;
  process.env['TENANT_SIGNING_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = APP_URL; // initialize never touches the DB
  server = startHttpServer(PORT);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function post(headers: Record<string, string>) {
  return fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: INIT_BODY,
  });
}

describe('ledger MCP http auth', () => {
  it('(a) accepts a signed tenant token as the bearer (vault shape)', async () => {
    const res = await post({ authorization: `Bearer ${createTenantToken(TENANT, SECRET)}` });
    expect(res.status).toBe(200);
  });

  it('(b) accepts service token + x-hisab-tenant header', async () => {
    const res = await post({
      authorization: `Bearer ${SERVICE}`,
      'x-hisab-tenant': createTenantToken(TENANT, SECRET),
    });
    expect(res.status).toBe(200);
  });

  it('PROBE: rejects a garbage bearer', async () => {
    const res = await post({ authorization: 'Bearer nonsense' });
    expect(res.status).toBe(401);
  });

  it('PROBE: rejects service token without a tenant header', async () => {
    const res = await post({ authorization: `Bearer ${SERVICE}` });
    expect(res.status).toBe(401);
  });

  it('PROBE: rejects a tenant token signed with the wrong secret', async () => {
    const res = await post({
      authorization: `Bearer ${createTenantToken(TENANT, 'wrong-secret')}`,
    });
    expect(res.status).toBe(401);
  });

  it('GET /healthz is a 200, no auth required (Docker/K8s probe)', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'mcp-ledger' });
  });
});
