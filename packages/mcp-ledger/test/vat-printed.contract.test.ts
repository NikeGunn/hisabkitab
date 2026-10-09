/**
 * VAT billing accuracy over the REAL Ledger MCP
 * + Postgres (RLS on). A bill's PRINTED taxable + VAT are stored exactly, and the same
 * figures flow tool result → DB row → VAT return summary. Probes: figures that don't
 * reconcile, half-supplied pairs, VAT from a non-VAT vendor, malformed numbers — none
 * may ever create a row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adToBs, splitVatInclusive, vatOnExclusive } from '@hisab/shared';
import { createDb, schema, type DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;
const BS_NOW = adToBs(TODAY);

/** A per-line-rounded vendor invoice whose VAT differs from re-deriving it from the total. */
const LINES = [50n, 150n, 250n, 123_450n, 67_850n]; // per-line VAT: 7, 20, 33, 16049, 8821
const T = LINES.reduce((a, t) => a + t, 0n);
const V = LINES.reduce((a, t) => a + vatOnExclusive(t), 0n);
const G = T + V;

let handle: DbHandle;
/** RLS-exempt admin connection, typed drizzle queries only (inspect what was stored). */
let admin: DbHandle;

beforeAll(() => {
  handle = appDb();
  admin = createDb(ADMIN_URL, 1);
});
afterAll(async () => {
  await admin.close();
  await handle.close();
});

async function fresh(name: string): Promise<{ s: TestSession; tenant: string }> {
  const tenant = await createTenant(name);
  return { s: await openSession(handle, tenant), tenant };
}

const expenseArgs = (extra: Record<string, unknown> = {}) => ({
  occurred_on: TODAY_ISO,
  vendor_name: 'Annapurna Hardware',
  vendor_is_vat_registered: true,
  invoice_no: `INV-${Math.random().toString(36).slice(2, 8)}`,
  invoice_type: 'rule17',
  amount_paisa: Number(G),
  is_service: false,
  for_taxable_business_use: true,
  printed_taxable_paisa: Number(T),
  printed_vat_paisa: Number(V),
  ...extra,
});

describe('fixture sanity', () => {
  it('the fixture really is a case the old re-derivation got wrong', () => {
    expect(splitVatInclusive(G).vatPaisa).not.toBe(V);
  });
});

describe('printed figures are stored exactly and reconcile end to end', () => {
  it('record_expense → DB row → VAT return all carry the PRINTED VAT', async () => {
    const { s, tenant } = await fresh('Printed Expense Pasal');
    try {
      const r = await s.callTool<Record<string, unknown>>('record_expense', expenseArgs());
      expect(r['saved']).toBe(true);
      expect(r['amount_excl_vat_paisa']).toBe(Number(T));
      expect(r['vat_paisa']).toBe(Number(V));
      expect(r['total_paisa']).toBe(Number(G));
      expect(r['input_vat_paisa']).toBe(Number(V));
      expect(r['vat_source']).toBe('as printed on the invoice');
      const computedVat = splitVatInclusive(G).vatPaisa;
      expect(BigInt(r['printed_vat_vs_13pct_paisa'] as number)).toBe(V - computedVat);

      const [row] = await admin.db
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.tenantId, tenant));
      expect(row!.amountExclVatPaisa).toBe(T);
      expect(row!.vatPaisa).toBe(V);
      expect(row!.inputVatPaisa).toBe(V);

      await s.callTool('confirm_entry', { entry_type: 'expense', entry_id: r['expense_id'] });
      const sum = await s.callTool<Record<string, number>>('generate_return_summary', {
        bs_year: BS_NOW.year,
        bs_month: BS_NOW.month,
      });
      expect(sum['input_vat_paisa']).toBe(Number(V));
    } finally {
      await s.close();
    }
  });

  it('record_sale → output VAT in the return equals the printed VAT', async () => {
    const { s } = await fresh('Printed Sale Pasal');
    try {
      const r = await s.callTool<Record<string, unknown>>('record_sale', {
        occurred_on: TODAY_ISO,
        amount_paisa: Number(G),
        printed_taxable_paisa: Number(T),
        printed_vat_paisa: Number(V),
      });
      expect(r['saved']).toBe(true);
      expect(r['vat_paisa']).toBe(Number(V));
      await s.callTool('confirm_entry', { entry_type: 'sale', entry_id: r['sale_id'] });
      const sum = await s.callTool<Record<string, number>>('generate_return_summary', {
        bs_year: BS_NOW.year,
        bs_month: BS_NOW.month,
      });
      expect(sum['output_vat_paisa']).toBe(Number(V));
    } finally {
      await s.close();
    }
  });

  it('credit sale + credit purchase store printed figures; balance = printed total', async () => {
    const { s, tenant } = await fresh('Printed ARAP Pasal');
    try {
      const ar = await s.callTool<Record<string, unknown>>('record_credit_sale', {
        party: 'Sharma Traders',
        issued_on: TODAY_ISO,
        amount_paisa: Number(G),
        printed_taxable_paisa: Number(T),
        printed_vat_paisa: Number(V),
      });
      expect(ar).toMatchObject({
        saved: true,
        taxable_paisa: Number(T),
        vat_paisa: Number(V),
        balance_paisa: Number(G),
      });
      const ap = await s.callTool<Record<string, unknown>>('record_credit_purchase', {
        party: 'Gurung Wholesale',
        billed_on: TODAY_ISO,
        amount_paisa: Number(G),
        vendor_is_vat_registered: true,
        invoice_type: 'rule17',
        for_taxable_business_use: true,
        printed_taxable_paisa: Number(T),
        printed_vat_paisa: Number(V),
      });
      expect(ap).toMatchObject({
        saved: true,
        taxable_paisa: Number(T),
        vat_paisa: Number(V),
        balance_paisa: Number(G),
      });
      const [a] = await admin.db
        .select()
        .from(schema.arInvoices)
        .where(eq(schema.arInvoices.tenantId, tenant));
      const [b] = await admin.db
        .select()
        .from(schema.apBills)
        .where(eq(schema.apBills.tenantId, tenant));
      for (const row of [a!, b!]) {
        expect(row.taxablePaisa).toBe(T);
        expect(row.vatPaisa).toBe(V);
        expect(row.totalPaisa).toBe(G);
      }
    } finally {
      await s.close();
    }
  });

  it('TDS uses the PRINTED taxable base (excludes VAT)', async () => {
    const { s } = await fresh('Printed TDS Pasal');
    try {
      const r = await s.callTool<{ saved: boolean; tds: { applies: boolean; tds_paisa: number } }>(
        'record_expense',
        expenseArgs({ is_service: true }),
      );
      expect(r.saved).toBe(true);
      expect(r.tds.applies).toBe(true);
      expect(r.tds.tds_paisa).toBe(Number((T * 150n + 5_000n) / 10_000n)); // 1.5% half-up of T
    } finally {
      await s.close();
    }
  });

  it('backward compatible: no printed figures → computed 13% split, as before', async () => {
    const { s } = await fresh('Computed Pasal');
    try {
      const r = await s.callTool<Record<string, unknown>>('record_sale', {
        occurred_on: TODAY_ISO,
        amount_paisa: 99_900,
      });
      expect(r).toMatchObject({
        saved: true,
        amount_excl_vat_paisa: 88_407,
        vat_paisa: 11_493,
        total_paisa: 99_900,
        vat_source: 'computed at 13%',
      });
      expect(r['printed_vat_vs_13pct_paisa']).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it('idempotent retry with printed figures creates exactly one row', async () => {
    const { s, tenant } = await fresh('Printed Idem Pasal');
    try {
      const args = expenseArgs({ idempotency_key: 'bill-photo-123' });
      const a = await s.callTool<Record<string, unknown>>('record_expense', args);
      const b = await s.callTool<Record<string, unknown>>('record_expense', args);
      expect(b['expense_id']).toBe(a['expense_id']);
      const rows = await admin.db
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.tenantId, tenant));
      expect(rows).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
});

describe('PROBES — nothing is ever saved', () => {
  async function expectNoRows(tenant: string) {
    const { expenses, sales, arInvoices, apBills } = schema;
    for (const t of [expenses, sales, arInvoices, apBills]) {
      const rows = await admin.db.select().from(t).where(eq(t.tenantId, tenant));
      expect(rows).toHaveLength(0);
    }
  }

  it('PROBE: printed taxable + VAT ≠ the total', async () => {
    const { s, tenant } = await fresh('Probe Mismatch');
    try {
      const r = await s.callTool<{ saved: boolean; reason: string }>(
        'record_expense',
        expenseArgs({ printed_vat_paisa: Number(V) + 100 }),
      );
      expect(r.saved).toBe(false);
      expect(r.reason).toMatch(/does not equal its total/);
      const ar = await s.callTool<{ saved: boolean }>('record_credit_sale', {
        party: 'X',
        issued_on: TODAY_ISO,
        amount_paisa: 113_000,
        printed_taxable_paisa: 100_000,
        printed_vat_paisa: 12_999,
      });
      expect(ar.saved).toBe(false);
      await expectNoRows(tenant);
    } finally {
      await s.close();
    }
  });

  it('PROBE: only one printed field supplied is refused (never half-trusted)', async () => {
    const { s, tenant } = await fresh('Probe Half');
    try {
      const r = await s.callTool<{ saved: boolean; reason: string }>('record_sale', {
        occurred_on: TODAY_ISO,
        amount_paisa: 113_000,
        printed_vat_paisa: 13_000,
      });
      expect(r.saved).toBe(false);
      expect(r.reason).toMatch(/BOTH/);
      await expectNoRows(tenant);
    } finally {
      await s.close();
    }
  });

  it('PROBE: VAT printed on a bill from a non-VAT-registered vendor is refused, not zeroed', async () => {
    const { s, tenant } = await fresh('Probe NonVat');
    try {
      const r = await s.callTool<{ saved: boolean; reason: string }>('record_credit_purchase', {
        party: 'Local Kirana',
        billed_on: TODAY_ISO,
        amount_paisa: 113_000,
        vendor_is_vat_registered: false,
        for_taxable_business_use: true,
        printed_taxable_paisa: 100_000,
        printed_vat_paisa: 13_000,
      });
      expect(r.saved).toBe(false);
      expect(r.reason).toMatch(/NOT VAT-registered/);
      await expectNoRows(tenant);
    } finally {
      await s.close();
    }
  });

  it('PROBE: malformed printed numbers (negative, fractional, beyond 2^53) are rejected at the boundary', async () => {
    const { s, tenant } = await fresh('Probe Malformed');
    try {
      for (const bad of [-1, 12.5, Number.MAX_SAFE_INTEGER + 2]) {
        const res = await s.callToolRaw('record_sale', {
          occurred_on: TODAY_ISO,
          amount_paisa: 113_000,
          printed_taxable_paisa: 100_000,
          printed_vat_paisa: bad,
        });
        expect(res.isError).toBe(true);
      }
      await expectNoRows(tenant);
    } finally {
      await s.close();
    }
  });
});
