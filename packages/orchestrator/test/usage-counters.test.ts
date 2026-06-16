/**
 * Usage-counter accounting (P11 cost controls, PRD v2.0 §7) over REAL Postgres as
 * hisab_orch. Proves the per-(tenant,period) counter accumulates idempotently, the
 * soft-warn latches exactly once, the spend dashboard orders costliest-first, and —
 * the PROBE — concurrent recordUsage calls never lose a turn (atomic `+=`).
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, getTenantSpend, getUsage, markWarned, recordUsage, type DbHandle } from '@hisab/db';
import { ADMIN_URL, ORCH_URL } from './urls.js';

const adminSql = postgres(ADMIN_URL, { max: 1 });
let orch: DbHandle;

async function makeTenant(name: string): Promise<string> {
  const [t] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, status)
    VALUES (${name}, '301234567', 'active') RETURNING id`;
  return t!['id'] as string;
}

const PERIOD = '2026-06';

beforeAll(() => {
  orch = createDb(ORCH_URL, 10);
});
afterAll(async () => {
  await orch.close();
  await adminSql.end({ timeout: 5 });
});
// No global cleanup: every test provisions its OWN tenant (unique UUID), so the
// (tenant, period) counters are naturally isolated and never collide with other
// suites running concurrently. (A global `DELETE FROM tenants` would race them.)

describe('recordUsage', () => {
  it('creates then accumulates a (tenant, period) counter', async () => {
    const t = await makeTenant('Accum Pasal');
    const first = await recordUsage(orch.db, t, { inputTokens: 100, outputTokens: 50, costPaisa: 30 }, PERIOD);
    expect(first.turns).toBe(1);
    expect(first.costPaisa).toBe(30);

    const second = await recordUsage(orch.db, t, { inputTokens: 200, outputTokens: 10, costPaisa: 70 }, PERIOD);
    expect(second.turns).toBe(2);
    expect(second.inputTokens).toBe(300);
    expect(second.outputTokens).toBe(60);
    expect(second.costPaisa).toBe(100);
  });

  it('different periods are separate buckets', async () => {
    const t = await makeTenant('Period Pasal');
    await recordUsage(orch.db, t, { inputTokens: 1, outputTokens: 1, costPaisa: 10 }, '2026-06');
    await recordUsage(orch.db, t, { inputTokens: 1, outputTokens: 1, costPaisa: 99 }, '2026-07');
    expect((await getUsage(orch.db, t, '2026-06'))!.costPaisa).toBe(10);
    expect((await getUsage(orch.db, t, '2026-07'))!.costPaisa).toBe(99);
  });

  it('floors negative / fractional inputs (never corrupts the total)', async () => {
    const t = await makeTenant('Junk Pasal');
    const r = await recordUsage(orch.db, t, { inputTokens: -5, outputTokens: 2.9, costPaisa: -1 }, PERIOD);
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(2);
    expect(r.costPaisa).toBe(0);
  });

  it('PROBE: concurrent recordUsage calls never lose a turn (atomic +=)', async () => {
    const t = await makeTenant('Race Pasal');
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () =>
        recordUsage(orch.db, t, { inputTokens: 10, outputTokens: 10, costPaisa: 4 }, PERIOD),
      ),
    );
    const final = await getUsage(orch.db, t, PERIOD);
    expect(final!.turns).toBe(N);
    expect(final!.costPaisa).toBe(N * 4);
  });
});

describe('markWarned latch', () => {
  it('returns true once, then false (owner nudged at most once per period)', async () => {
    const t = await makeTenant('Warn Pasal');
    await recordUsage(orch.db, t, { inputTokens: 1, outputTokens: 1, costPaisa: 1 }, PERIOD);
    expect(await markWarned(orch.db, t, PERIOD)).toBe(true);
    expect(await markWarned(orch.db, t, PERIOD)).toBe(false);
    expect((await getUsage(orch.db, t, PERIOD))!.warnedAt).not.toBeNull();
  });
});

describe('getTenantSpend dashboard', () => {
  it('lists a period costliest-first', async () => {
    const a = await makeTenant('Cheap');
    const b = await makeTenant('Spendy');
    await recordUsage(orch.db, a, { inputTokens: 1, outputTokens: 1, costPaisa: 100 }, PERIOD);
    await recordUsage(orch.db, b, { inputTokens: 1, outputTokens: 1, costPaisa: 9000 }, PERIOD);
    // getTenantSpend is cross-tenant by design (the ops dashboard), so other suites'
    // tenants may also appear — filter to the two we created and assert their order.
    const spend = await getTenantSpend(orch.db, PERIOD);
    const ours = spend.map((r) => r.tenantId).filter((id) => id === a || id === b);
    expect(ours).toEqual([b, a]); // costliest (b) first
  });
});
