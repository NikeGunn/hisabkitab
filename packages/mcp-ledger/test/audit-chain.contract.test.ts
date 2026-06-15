/**
 * Audit-log hash-chain contract test (PRD v2.0 §9) over the REAL tenant-bound
 * Ledger MCP + Postgres. Proves every tool write is chained, verify_audit_chain
 * returns PASS on an intact log, and — the adversarial PROBE — a row edited
 * directly in the DB is DETECTED (FAIL). The audit log is the single source of
 * truth; tampering with it must never go unnoticed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;

let handle: DbHandle;
let session: TestSession;
let tenantId: string;
const admin = postgres(ADMIN_URL, { max: 2 });

beforeAll(async () => {
  handle = appDb();
  tenantId = await createTenant('Audit Chain Pasal');
  session = await openSession(handle, tenantId);
});

afterAll(async () => {
  await session.close();
  await admin.end({ timeout: 5 });
  await handle.close();
});

type ChainResult = { verdict: string; rows: number; broken_at_index?: number; reason?: string };

describe('audit-log hash-chain', () => {
  it('every tool write is chained; verify_audit_chain PASSes on an intact log', async () => {
    // generate several audited writes (each records an audit_log row)
    await session.callTool('record_sale', { occurred_on: TODAY_ISO, amount_paisa: 113_000 });
    await session.callTool('record_sale', { occurred_on: TODAY_ISO, amount_paisa: 226_000 });
    await session.callTool('record_sale', { occurred_on: TODAY_ISO, amount_paisa: 339_000 });

    const rows = await admin`SELECT count(*)::int AS c FROM audit_log WHERE tenant_id = ${tenantId} AND row_hash IS NOT NULL`;
    expect((rows[0]!['c'] as number)).toBeGreaterThanOrEqual(3);

    const v = await session.callTool<ChainResult>('verify_audit_chain', {});
    expect(v.verdict).toBe('PASS');
    expect(v.rows).toBeGreaterThanOrEqual(3);
  });

  it('PROBE: editing an audit row detail directly in the DB is DETECTED (FAIL)', async () => {
    // tamper: change the detail of the tenant's 2nd chained row, leaving its hash.
    const target = await admin`
      SELECT id FROM audit_log
      WHERE tenant_id = ${tenantId} AND row_hash IS NOT NULL
      ORDER BY id LIMIT 1 OFFSET 1`;
    await admin`UPDATE audit_log SET detail = '{"tampered": true}'::jsonb WHERE id = ${target[0]!['id']}`;

    const v = await session.callTool<ChainResult>('verify_audit_chain', {});
    expect(v.verdict).toBe('FAIL');
    expect(v.reason).toMatch(/altered|mismatch/);
  });

  it('PROBE: deleting an audit row mid-chain is DETECTED (FAIL)', async () => {
    // delete the FIRST chained row — every later prev_hash now dangles.
    const target = await admin`
      SELECT id FROM audit_log
      WHERE tenant_id = ${tenantId} AND row_hash IS NOT NULL
      ORDER BY id LIMIT 1`;
    await admin`DELETE FROM audit_log WHERE id = ${target[0]!['id']}`;
    const v = await session.callTool<ChainResult>('verify_audit_chain', {});
    expect(v.verdict).toBe('FAIL');
  });
});
