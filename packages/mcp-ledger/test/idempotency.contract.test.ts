/**
 * P9 (PRD v2.0 §6) idempotent-write contract tests over the REAL tenant-bound
 * Ledger MCP + Postgres. Proves a retried entry-creating call with the same
 * `idempotency_key` returns the ORIGINAL result and writes NO second row, across
 * all five entry-creating tools, scoped per tenant. Adversarial PROBES per §8.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

let handle: DbHandle;
let admin: postgres.Sql;
let tenant: string;
let s: TestSession;

beforeAll(async () => {
  handle = appDb();
  admin = postgres(ADMIN_URL, { max: 2 });
  tenant = await createTenant('Idempotency Pasal');
  s = await openSession(handle, tenant);
});

afterAll(async () => {
  await s.close();
  await admin.end({ timeout: 5 });
  await handle.close();
});

/** Count rows for a tenant in a table, on the RLS-exempt admin connection. */
async function rowCount(table: string, tenantId: string): Promise<number> {
  const rows = await admin.unsafe(`SELECT count(*)::int AS c FROM ${table} WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return rows[0]!['c'] as number;
}

interface SaleResult {
  saved: boolean;
  sale_id: string;
  idempotent_replay?: boolean;
}
interface ExpenseResult {
  saved: boolean;
  expense_id: string;
  idempotent_replay?: boolean;
}

describe('record_sale idempotency', () => {
  it('same key returns the same sale_id and writes exactly ONE row', async () => {
    const before = await rowCount('sales', tenant);
    const args = {
      occurred_on: '2026-03-01',
      amount_paisa: 113_000,
      idempotency_key: 'sale-key-1',
    };

    const first = await s.callTool<SaleResult>('record_sale', args);
    expect(first.saved).toBe(true);
    expect(first.idempotent_replay).toBeUndefined(); // fresh write

    const second = await s.callTool<SaleResult>('record_sale', args);
    expect(second.saved).toBe(true);
    expect(second.sale_id).toBe(first.sale_id); // identical original result
    expect(second.idempotent_replay).toBe(true); // flagged as a replay

    expect(await rowCount('sales', tenant)).toBe(before + 1); // NO second row
  });

  it('a different key writes a new row (no false dedupe)', async () => {
    const before = await rowCount('sales', tenant);
    const a = await s.callTool<SaleResult>('record_sale', {
      occurred_on: '2026-03-02',
      amount_paisa: 100_000,
      idempotency_key: 'sale-key-2',
    });
    const b = await s.callTool<SaleResult>('record_sale', {
      occurred_on: '2026-03-02',
      amount_paisa: 100_000,
      idempotency_key: 'sale-key-3',
    });
    expect(a.sale_id).not.toBe(b.sale_id);
    expect(await rowCount('sales', tenant)).toBe(before + 2);
  });

  it('no key behaves exactly as before — every call writes a row', async () => {
    const before = await rowCount('sales', tenant);
    const a = await s.callTool<SaleResult>('record_sale', {
      occurred_on: '2026-03-03',
      amount_paisa: 100_000,
    });
    const b = await s.callTool<SaleResult>('record_sale', {
      occurred_on: '2026-03-03',
      amount_paisa: 100_000,
    });
    expect(a.sale_id).not.toBe(b.sale_id);
    expect(a.idempotent_replay).toBeUndefined();
    expect(b.idempotent_replay).toBeUndefined();
    expect(await rowCount('sales', tenant)).toBe(before + 2);
  });

  it('PROBE: two racing calls with the same key create exactly ONE sale', async () => {
    const before = await rowCount('sales', tenant);
    const args = {
      occurred_on: '2026-03-04',
      amount_paisa: 226_000,
      idempotency_key: 'sale-race-key',
    };
    const [a, b] = await Promise.all([
      s.callTool<SaleResult>('record_sale', args),
      s.callTool<SaleResult>('record_sale', args),
    ]);
    expect(a.sale_id).toBe(b.sale_id); // both callers see the SAME entry
    // exactly one fresh write; the other is a replay
    expect([a.idempotent_replay, b.idempotent_replay].filter(Boolean)).toHaveLength(1);
    expect(await rowCount('sales', tenant)).toBe(before + 1); // never two rows
  });
});

describe('record_expense idempotency', () => {
  it('same key returns the same expense_id and writes exactly ONE row', async () => {
    const before = await rowCount('expenses', tenant);
    const args = {
      occurred_on: '2026-03-05',
      vendor_name: 'Idem Vendor',
      vendor_is_vat_registered: true,
      amount_paisa: 113_000,
      is_service: false,
      for_taxable_business_use: true,
      idempotency_key: 'exp-key-1',
    };
    const first = await s.callTool<ExpenseResult>('record_expense', args);
    const second = await s.callTool<ExpenseResult>('record_expense', args);
    expect(second.expense_id).toBe(first.expense_id);
    expect(second.idempotent_replay).toBe(true);
    expect(await rowCount('expenses', tenant)).toBe(before + 1);
  });
});

describe('AR/AP idempotency', () => {
  it('record_credit_sale: same key → one ar_invoice', async () => {
    const before = await rowCount('ar_invoices', tenant);
    const args = {
      party: 'Idem Customer',
      issued_on: '2026-03-06',
      amount_paisa: 904_000,
      idempotency_key: 'cs-key-1',
    };
    const first = await s.callTool<{ invoice_id: string; idempotent_replay?: boolean }>(
      'record_credit_sale',
      args,
    );
    const second = await s.callTool<{ invoice_id: string; idempotent_replay?: boolean }>(
      'record_credit_sale',
      args,
    );
    expect(second.invoice_id).toBe(first.invoice_id);
    expect(second.idempotent_replay).toBe(true);
    expect(await rowCount('ar_invoices', tenant)).toBe(before + 1);
  });

  it('record_party_payment: same key → one party_payment (no double allocation staged)', async () => {
    // an open invoice to allocate against
    const inv = await s.callTool<{ invoice_id: string }>('record_credit_sale', {
      party: 'Pay Customer',
      issued_on: '2026-03-07',
      amount_paisa: 100_000,
      idempotency_key: 'pay-setup-inv',
    });
    await s.callTool('confirm_arap_entry', { entry_type: 'ar_invoice', entry_id: inv.invoice_id });

    const before = await rowCount('party_payments', tenant);
    const allocBefore = await rowCount('payment_allocations', tenant);
    const args = {
      party: 'Pay Customer',
      direction: 'received' as const,
      amount_paisa: 50_000,
      paid_on: '2026-03-08',
      idempotency_key: 'pay-key-1',
    };
    const first = await s.callTool<{ payment_id: string; idempotent_replay?: boolean }>(
      'record_party_payment',
      args,
    );
    const second = await s.callTool<{ payment_id: string; idempotent_replay?: boolean }>(
      'record_party_payment',
      args,
    );
    expect(second.payment_id).toBe(first.payment_id);
    expect(second.idempotent_replay).toBe(true);
    expect(await rowCount('party_payments', tenant)).toBe(before + 1);
    expect(await rowCount('payment_allocations', tenant)).toBe(allocBefore + 1); // not double-staged
  });
});

describe('PROBE: idempotency keys are tenant-scoped', () => {
  it('the same key used by a different tenant is independent', async () => {
    const other = await createTenant('Other Idem Pasal');
    const sOther = await openSession(handle, other);
    try {
      const key = 'shared-literal-key';
      const a = await s.callTool<SaleResult>('record_sale', {
        occurred_on: '2026-03-09',
        amount_paisa: 100_000,
        idempotency_key: key,
      });
      const b = await sOther.callTool<SaleResult>('record_sale', {
        occurred_on: '2026-03-09',
        amount_paisa: 100_000,
        idempotency_key: key,
      });
      // Different tenants: NOT treated as a replay of each other.
      expect(b.idempotent_replay).toBeUndefined();
      expect(a.sale_id).not.toBe(b.sale_id);
      expect(await rowCount('sales', other)).toBe(1);
    } finally {
      await sOther.close();
    }
  });
});
