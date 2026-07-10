/**
 * Worst-case probes for the connector trust boundary: expired setup codes, revoked
 * device tokens, one connector forging results for another connector's job, and two
 * connectors racing to claim the same job (must be exactly-once).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { withTenant, schema, type DbHandle } from '@hisab/db';
import { authConnector, claimJob, postResult, registerConnector } from '../src/connector-api.js';
import { appDb, orchDb, createTenant } from './helpers.js';
import { ADMIN_URL } from './urls.js';

let app: DbHandle;
let orch: DbHandle;
let tenantX: string;
let tenantY: string;

async function issueCode(tenantId: string, code: string, expiresInMs = 60_000): Promise<void> {
  await withTenant(app.db, tenantId, async (tx) => {
    await tx.insert(schema.tallyConnectors).values({
      tenantId,
      setupCode: code,
      setupCodeExpiresAt: new Date(Date.now() + expiresInMs),
    });
  });
}

async function queueJob(tenantId: string, connectorId: string): Promise<string> {
  const sql = postgres(ADMIN_URL, { max: 1 });
  try {
    const [row] = await sql`
      INSERT INTO tally_jobs (tenant_id, connector_id, operation, params)
      VALUES (${tenantId}, ${connectorId}, 'health', '{}') RETURNING id`;
    return row!['id'] as string;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  app = appDb();
  orch = orchDb();
  tenantX = await createTenant('Worst Case X');
  tenantY = await createTenant('Worst Case Y');
});
afterAll(async () => {
  await Promise.all([app.close(), orch.close()]);
});

describe('setup-code lifecycle', () => {
  it('an EXPIRED setup code is refused (PROBE)', async () => {
    await issueCode(tenantX, 'EXPIRED2', -1_000); // already past expiry
    expect((await registerConnector(orch.db, { setup_code: 'EXPIRED2' })).kind).toBe(
      'invalid_code',
    );
  });

  it('codes are case-normalized but never fuzzy-matched (PROBE)', async () => {
    await issueCode(tenantX, 'GOODCODE');
    expect((await registerConnector(orch.db, { setup_code: 'GOODCOD' })).kind).toBe('invalid_code');
    expect((await registerConnector(orch.db, { setup_code: '  goodcode ' })).kind).toBe(
      'registered',
    );
  });
});

describe('device-token lifecycle', () => {
  it('a REVOKED connector token stops authenticating immediately (PROBE)', async () => {
    await issueCode(tenantX, 'TOREVOKE');
    const reg = await registerConnector(orch.db, { setup_code: 'TOREVOKE' });
    if (reg.kind !== 'registered') throw new Error('setup failed');
    expect(await authConnector(orch.db, reg.connectorToken)).not.toBeNull();

    const sql = postgres(ADMIN_URL, { max: 1 });
    try {
      await sql`UPDATE tally_connectors SET status = 'revoked' WHERE id = ${reg.connectorId}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    expect(await authConnector(orch.db, reg.connectorToken)).toBeNull();
  });
});

describe('cross-connector integrity', () => {
  it("connector B cannot claim or answer connector A's job (PROBE: forged result)", async () => {
    await issueCode(tenantX, 'CONNAAAA');
    await issueCode(tenantY, 'CONNBBBB');
    const a = await registerConnector(orch.db, { setup_code: 'CONNAAAA' });
    const b = await registerConnector(orch.db, { setup_code: 'CONNBBBB' });
    if (a.kind !== 'registered' || b.kind !== 'registered') throw new Error('setup failed');

    const jobId = await queueJob(tenantX, a.connectorId);
    // B polls: sees NOTHING (the job belongs to A)
    expect(await claimJob(orch.db, b.connectorId, 200, 50)).toBeNull();
    // A claims it; B tries to post a forged result for it — refused
    const claimed = await claimJob(orch.db, a.connectorId, 1_000, 50);
    expect(claimed?.id).toBe(jobId);
    const forged = { op: 'health', ok: true, simulator: true, payload: { tally_reachable: true } };
    expect(await postResult(orch.db, b.connectorId, jobId, forged)).toBe('unknown_job');
    // A's own result still lands
    expect(await postResult(orch.db, a.connectorId, jobId, forged)).toBe('stored');
  });

  it('two racing claims win the SAME job exactly once (PROBE: SKIP LOCKED)', async () => {
    await issueCode(tenantX, 'RACECODE');
    const reg = await registerConnector(orch.db, { setup_code: 'RACECODE' });
    if (reg.kind !== 'registered') throw new Error('setup failed');
    const jobId = await queueJob(tenantX, reg.connectorId);

    const [first, second] = await Promise.all([
      claimJob(orch.db, reg.connectorId, 500, 25),
      claimJob(orch.db, reg.connectorId, 200, 25),
    ]);
    const winners = [first, second].filter((j) => j?.id === jobId);
    expect(winners).toHaveLength(1);
  });

  it('garbage envelopes never land in the DB (PROBE: schema at the door)', async () => {
    await issueCode(tenantX, 'GARBAGE2');
    const reg = await registerConnector(orch.db, { setup_code: 'GARBAGE2' });
    if (reg.kind !== 'registered') throw new Error('setup failed');
    const jobId = await queueJob(tenantX, reg.connectorId);
    await claimJob(orch.db, reg.connectorId, 1_000, 50);
    expect(
      await postResult(orch.db, reg.connectorId, jobId, { op: 'post_raw_voucher', ok: true }),
    ).toBe('unknown_job');
    expect(await postResult(orch.db, reg.connectorId, jobId, 'not even an object')).toBe(
      'unknown_job',
    );
  });
});
