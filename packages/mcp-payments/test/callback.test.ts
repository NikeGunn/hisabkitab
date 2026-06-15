/**
 * The public Khalti return-URL is unauthenticated and retried/replayed by
 * nature (it's the payer's browser). It must trust NOTHING from the query
 * string except pidx: settlement happens only via a fresh server-side lookup,
 * exactly once — a forged "status=Completed" must record nothing.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@hisab/db';
import { buildPaymentsHttpServer } from '../src/http.js';
import { KhaltiClient } from '../src/khalti.js';
import { startKhaltiStub, type KhaltiStub } from '../src/khalti-stub.js';
import { appDb, createTenant, openSession, STUB_SECRET, type TestSession } from './helpers.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

let stub: KhaltiStub;
let appHandle: DbHandle;
let orchHandle: DbHandle;
let session: TestSession;
let base: string;
let server: ReturnType<typeof buildPaymentsHttpServer>;
const adminSql = postgres(ADMIN_URL, { max: 1 });

beforeAll(async () => {
  stub = await startKhaltiStub(STUB_SECRET);
  appHandle = appDb();
  orchHandle = createDb(ORCH_URL, 2);
  const tenantId = await createTenant('Callback Pasal');
  session = await openSession(appHandle, tenantId, stub);

  server = buildPaymentsHttpServer({
    serviceToken: 'callback-test-service-token',
    signingSecret: 'callback-test-secret',
    appDb: appHandle.db,
    orchDb: orchHandle.db,
    khalti: new KhaltiClient({ secretKey: STUB_SECRET, origin: stub.origin }),
    returnUrl: 'http://127.0.0.1:0/payments/khalti/return',
    websiteUrl: 'https://hisabkitab.example',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await session.close();
  await new Promise<void>((r) => server.close(() => r()));
  await appHandle.close();
  await orchHandle.close();
  await stub.close();
  await adminSql.end({ timeout: 5 });
});

const salesCountFor = async (gatewayRef: string): Promise<number> => {
  const rows = await adminSql`SELECT count(*)::int AS n FROM sales WHERE gateway_ref = ${gatewayRef}`;
  return rows[0]?.['n'] as number;
};

const hitCallback = (query: string) => fetch(`${base}/payments/khalti/return?${query}`);

describe('GET /healthz', () => {
  it('is a 200, no auth required (Docker/K8s probe)', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'mcp-payments' });
  });
});

describe('GET /payments/khalti/return', () => {
  it('PROBE: a FORGED "status=Completed" with an unpaid pidx records NOTHING', async () => {
    const init = await session.callTool<{ pidx: string }>('initiate_payment', {
      amount_paisa: 904000,
      purpose: 'callback probe',
      owner_approved: true,
    });
    // attacker crafts the redirect Khalti would send on success — but the
    // gateway's lookup still says Initiated
    const res = await hitCallback(`pidx=${init.pidx}&status=Completed&amount=904000&transaction_id=fake`);
    expect(res.status).toBe(200);
    expect(await salesCountFor(init.pidx)).toBe(0);
    const row = await adminSql`SELECT status FROM payments WHERE pidx = ${init.pidx}`;
    expect(row[0]?.['status']).toBe('initiated');
  });

  it('settles a genuinely paid pidx — and a replayed callback stays exactly-once', async () => {
    const init = await session.callTool<{ pidx: string }>('initiate_payment', {
      amount_paisa: 452000,
      purpose: 'callback success',
      owner_approved: true,
    });
    stub.completePayment(init.pidx);

    const res1 = await hitCallback(`pidx=${init.pidx}&status=Completed`);
    expect(res1.status).toBe(200);
    expect(await res1.text()).toMatch(/Payment received/);
    expect(await salesCountFor(init.pidx)).toBe(1);

    // browser refresh / replay
    const res2 = await hitCallback(`pidx=${init.pidx}&status=Completed`);
    expect(res2.status).toBe(200);
    expect(await salesCountFor(init.pidx)).toBe(1);

    const sale = await adminSql`SELECT status, source FROM sales WHERE gateway_ref = ${init.pidx}`;
    expect(sale[0]).toMatchObject({ status: 'confirmed', source: 'gateway' });
  });

  it('an unknown pidx gets a graceful page and records nothing', async () => {
    const res = await hitCallback('pidx=does-not-exist&status=Completed');
    expect(res.status).toBe(200);
    expect(await salesCountFor('does-not-exist')).toBe(0);
  });

  it('PROBE: MCP endpoint still requires auth (callback route does not weaken it)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(res.status).toBe(401);
  });
});
