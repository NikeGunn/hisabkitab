/**
 * Connector API over REAL HTTP (startHttpServer): registration, device-token auth,
 * claim/result lifecycle, and the oversized-body cap. Complements the contract suite
 * (which drives the same core functions in-process).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { withTenant, type DbHandle } from '@hisab/db';
import { schema } from '@hisab/db';
import { appDb, createTenant } from './helpers.js';
import { ADMIN_URL, APP_URL, ORCH_URL } from './urls.js';

let server: Server;
let base: string;
let app: DbHandle;
let tenantId: string;
let setupCode: string;
let token: string;

beforeAll(async () => {
  process.env['TALLY_MCP_TOKEN'] = 'test-service-token';
  process.env['TENANT_SIGNING_SECRET'] = 'test-signing-secret';
  process.env['DATABASE_URL'] = APP_URL;
  process.env['CONNECTOR_DATABASE_URL'] = ORCH_URL;
  const { startHttpServer } = await import('../src/http.js');
  server = startHttpServer(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  app = appDb();
  tenantId = await createTenant('HTTP Test Business');
  // Issue a setup code the way the tool does (tenant-scoped insert).
  setupCode = 'HTTPTEST2';
  await withTenant(app.db, tenantId, async (tx) => {
    await tx.insert(schema.tallyConnectors).values({
      tenantId,
      setupCode,
      setupCodeExpiresAt: new Date(Date.now() + 60_000),
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await app.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('registration', () => {
  it('rejects a wrong code (403), accepts the real one ONCE', async () => {
    expect((await post('/connector/register', { setup_code: 'WRONG999' })).status).toBe(403);

    const ok = await post('/connector/register', { setup_code: setupCode, connector_version: 't' });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { connector_token: string; connector_id: string };
    expect(body.connector_token).toMatch(/^[0-9a-f]{64}$/);
    token = body.connector_token;

    // single-use: replaying the consumed code fails
    expect((await post('/connector/register', { setup_code: setupCode })).status).toBe(403);
  });
});

describe('claim + result', () => {
  it('claim requires a valid device token (PROBE: 401s)', async () => {
    expect((await post('/connector/claim', {})).status).toBe(401);
    expect((await post('/connector/claim', {}, { authorization: 'Bearer deadbeef' })).status).toBe(
      401,
    );
  });

  it('claims a queued job and posts its result; a foreign/finished job is refused', async () => {
    // queue a job as the tool would (tenant-scoped insert)
    const sql = postgres(ADMIN_URL, { max: 1 });
    let jobId: string;
    try {
      const [connector] = await sql`SELECT id FROM tally_connectors WHERE tenant_id = ${tenantId}`;
      const [job] = await sql`
        INSERT INTO tally_jobs (tenant_id, connector_id, operation, params)
        VALUES (${tenantId}, ${connector!['id'] as string}, 'health', '{}') RETURNING id`;
      jobId = job!['id'] as string;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const auth = { authorization: `Bearer ${token}` };
    const claim = await post('/connector/claim', {}, auth);
    expect(claim.status).toBe(200);
    const { job } = (await claim.json()) as { job: { id: string; operation: string } };
    expect(job).toMatchObject({ id: jobId, operation: 'health' });

    const envelope = {
      op: 'health',
      ok: true,
      simulator: true,
      payload: { tally_reachable: true },
    };
    expect((await post('/connector/result', { job_id: jobId, envelope }, auth)).status).toBe(200);
    // a second result for the same (now finished) job is refused
    expect((await post('/connector/result', { job_id: jobId, envelope }, auth)).status).toBe(409);
  });

  it('an oversized result body is refused (PROBE: size cap)', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const huge = JSON.stringify({ job_id: 'x', envelope: { blob: 'a'.repeat(1_100_000) } });
    expect((await post('/connector/result', huge, auth)).status).toBe(400);
  });
});
