/**
 * Acceptance criterion (PRD v1.1 §16): "Tenant B's data is provably invisible to
 * tenant A (RLS test)." Verified through the real app role (hisab_app, NOSUPERUSER)
 * and through the MCP tool surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { adToBs } from '@hisab/shared';
import { withTenant, type DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';

const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;
const BS_NOW = adToBs(TODAY);

let handle: DbHandle;
let tenantA: string;
let tenantB: string;
let sessionA: TestSession;
let sessionB: TestSession;
let saleA: string;

beforeAll(async () => {
  handle = appDb();
  [tenantA, tenantB] = await Promise.all([createTenant('Tenant A Pasal'), createTenant('Tenant B Bhojanalaya')]);
  [sessionA, sessionB] = await Promise.all([openSession(handle, tenantA), openSession(handle, tenantB)]);
  const r = await sessionA.callTool<{ sale_id: string }>('record_sale', {
    occurred_on: TODAY_ISO,
    description: 'secret sale of tenant A',
    amount_paisa: 904000,
  });
  saleA = r.sale_id;
  await sessionA.callTool('confirm_entry', { entry_type: 'sale', entry_id: saleA });
});

afterAll(async () => {
  await sessionA.close();
  await sessionB.close();
  await handle.close();
});

describe('RLS tenant isolation', () => {
  it("tenant B's tool surface cannot see tenant A's transactions", async () => {
    const r = await sessionB.callTool<{ items: unknown[]; count: number }>('list_transactions', {
      bs_year: BS_NOW.year,
      bs_month: BS_NOW.month,
    });
    expect(r.count).toBe(0);
  });

  it("tenant B's return summary is nil despite A's confirmed sale", async () => {
    const r = await sessionB.callTool<{ is_nil: boolean; output_vat_paisa: number }>('generate_return_summary', {
      bs_year: BS_NOW.year,
      bs_month: BS_NOW.month,
    });
    expect(r.is_nil).toBe(true);
    expect(r.output_vat_paisa).toBe(0);
  });

  it("PROBE: tenant B cannot confirm tenant A's draft/confirmed entry by guessing its id", async () => {
    const r = await sessionB.callTool<{ ok: boolean }>('confirm_entry', { entry_type: 'sale', entry_id: saleA });
    expect(r.ok).toBe(false);
  });

  it('PROBE: raw SQL through the app role under tenant B sees zero of A’s rows', async () => {
    const rows = await withTenant(handle.db, tenantB, async (tx) => {
      const result = await tx.execute(sql`SELECT id FROM sales`);
      return result as unknown as unknown[];
    });
    expect(Array.from(rows as Iterable<unknown>)).toHaveLength(0);
  });

  it('PROBE: with NO tenant context at all, RLS fails closed (zero rows, not an error leak)', async () => {
    const result = await handle.db.execute(sql`SELECT id FROM sales`);
    expect(Array.from(result as unknown as Iterable<unknown>)).toHaveLength(0);
  });

  it('tenant A still sees its own data (isolation, not lockout)', async () => {
    const r = await sessionA.callTool<{ count: number }>('list_transactions', {
      bs_year: BS_NOW.year,
      bs_month: BS_NOW.month,
    });
    expect(r.count).toBe(1);
  });
});
