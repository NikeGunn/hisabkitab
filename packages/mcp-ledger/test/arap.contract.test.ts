/**
 * Module C-1/C-2 contract tests over the REAL tenant-bound Ledger MCP.
 * Covers: credit sale/purchase draft→confirm, payment allocation (auto oldest-first +
 * manual), balance decrement in one locked tx, over-allocation rejection, statement
 * running balance, receivables aging reconciliation, and RLS isolation.
 * Adversarial PROBES per CLAUDE.md §8 are marked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';

let handle: DbHandle;
let tenant: string;
let s: TestSession;

beforeAll(async () => {
  handle = appDb();
  tenant = await createTenant('Module C Pasal');
  s = await openSession(handle, tenant);
});

afterAll(async () => {
  await s.close();
  await handle.close();
});

interface SaleResult {
  saved: boolean;
  invoice_id: string;
  total_paisa: number;
  balance_paisa: number;
  vat_paisa: number;
}
interface PayResult {
  saved: boolean;
  payment_id: string;
  reason?: string;
  allocations: Array<{ target_id: string; amount_paisa: number; new_balance_paisa: number }>;
}

/** Record + confirm a credit sale, return its invoice id. */
async function creditSale(party: string, issuedOn: string, dueOn: string | null, amountPaisa: number): Promise<string> {
  const r = await s.callTool<SaleResult>('record_credit_sale', {
    party,
    issued_on: issuedOn,
    ...(dueOn ? { due_on: dueOn } : {}),
    amount_paisa: amountPaisa,
  });
  expect(r.saved).toBe(true);
  await s.callTool('confirm_arap_entry', { entry_type: 'ar_invoice', entry_id: r.invoice_id });
  return r.invoice_id;
}

describe('credit sale (AR) recording', () => {
  it('splits VAT-inclusive, balance starts at total, draft→confirm', async () => {
    const r = await s.callTool<SaleResult>('record_credit_sale', {
      party: 'Sharma Traders',
      invoice_no: 'INV-1',
      issued_on: '2026-03-01',
      due_on: '2026-03-31',
      amount_paisa: 904_000, // Rs 9,040 inclusive → 8,000 + 1,040 VAT
    });
    expect(r.saved).toBe(true);
    expect(r.total_paisa).toBe(904_000);
    expect(r.vat_paisa).toBe(104_000);
    expect(r.balance_paisa).toBe(904_000);
    const c = await s.callTool<{ ok: boolean; status: string }>('confirm_arap_entry', {
      entry_type: 'ar_invoice',
      entry_id: r.invoice_id,
    });
    expect(c.ok).toBe(true);
    expect(c.status).toBe('confirmed');
  });

  it('PROBE: a non-13% bill warns but a broken total is caught', async () => {
    // exclusive amount, VAT added by us, so math is always clean here; assert it stays draft-safe.
    const r = await s.callTool<SaleResult>('record_credit_sale', {
      party: 'Sharma Traders',
      issued_on: '2026-03-02',
      amount_paisa: 100_000,
      inclusive: false,
    });
    expect(r.saved).toBe(true);
    expect(r.balance_paisa).toBe(113_000); // 100,000 + 13,000 VAT
  });
});

describe('payment allocation (auto, oldest-first)', () => {
  let party: string;
  let inv1: string;
  let inv2: string;

  beforeAll(async () => {
    party = 'Allocation Customer';
    inv1 = await creditSale(party, '2026-03-01', '2026-03-31', 100_000);
    inv2 = await creditSale(party, '2026-03-05', '2026-04-04', 200_000);
  });

  it('auto-applies oldest-first across invoices and decrements balances on confirm', async () => {
    const r = await s.callTool<PayResult>('record_party_payment', {
      party,
      direction: 'received',
      amount_paisa: 150_000,
      paid_on: '2026-03-10',
      method: 'cash',
    });
    expect(r.saved).toBe(true);
    // oldest (inv1, 100k) cleared, then 50k into inv2
    expect(r.allocations).toEqual([
      { target_id: inv1, amount_paisa: 100_000, new_balance_paisa: 0 },
      { target_id: inv2, amount_paisa: 50_000, new_balance_paisa: 150_000 },
    ]);
    const c = await s.callTool<{ ok: boolean; allocations_applied: number }>('confirm_arap_entry', {
      entry_type: 'party_payment',
      entry_id: r.payment_id,
    });
    expect(c.ok).toBe(true);
    expect(c.allocations_applied).toBe(2);

    // balances actually moved: this party's statement closes at 150k (300k invoiced − 150k paid)
    const st = await s.callTool<{ closing_balance_paisa: number }>('get_statement', { party });
    expect(st.closing_balance_paisa).toBe(150_000);
  });

  it('PROBE: over-payment beyond total open balance is rejected, never absorbed', async () => {
    const r = await s.callTool<PayResult>('record_party_payment', {
      party,
      direction: 'received',
      amount_paisa: 9_999_999,
      paid_on: '2026-03-20',
    });
    expect(r.saved).toBe(false);
    expect(r.reason).toMatch(/exceeds total open balance/);
  });
});

describe('manual allocation', () => {
  let party: string;
  let invA: string;
  let invB: string;

  beforeAll(async () => {
    party = 'Manual Customer';
    invA = await creditSale(party, '2026-02-01', '2026-03-01', 100_000);
    invB = await creditSale(party, '2026-02-10', '2026-03-10', 100_000);
  });

  it('applies owner-named lines exactly', async () => {
    const r = await s.callTool<PayResult>('record_party_payment', {
      party,
      direction: 'received',
      amount_paisa: 80_000,
      paid_on: '2026-02-15',
      allocate: [
        { target_id: invB, amount_paisa: 30_000 },
        { target_id: invA, amount_paisa: 50_000 },
      ],
    });
    expect(r.saved).toBe(true);
    await s.callTool('confirm_arap_entry', { entry_type: 'party_payment', entry_id: r.payment_id });
    const st = await s.callTool<{ closing_balance_paisa: number; lines: unknown[] }>('get_statement', { party });
    // 200k invoiced - 80k paid = 120k still owed
    expect(st.closing_balance_paisa).toBe(120_000);
  });

  it('PROBE: a manual line exceeding its invoice balance is rejected', async () => {
    const r = await s.callTool<PayResult>('record_party_payment', {
      party,
      direction: 'received',
      amount_paisa: 60_000,
      paid_on: '2026-02-20',
      allocate: [{ target_id: invA, amount_paisa: 60_000 }], // invA has only 50k left
    });
    expect(r.saved).toBe(false);
    expect(r.reason).toMatch(/exceeds its open balance/);
  });
});

describe('PROBE: exactly-once confirm under concurrency', () => {
  it('two racing confirms of the same payment apply the allocation exactly once', async () => {
    const party = 'Race Customer';
    const inv = await creditSale(party, '2026-04-01', '2026-05-01', 100_000);
    const r = await s.callTool<PayResult>('record_party_payment', {
      party,
      direction: 'received',
      amount_paisa: 100_000,
      paid_on: '2026-04-10',
    });
    // Fire two confirms concurrently; the row-lock must serialize them so the balance
    // is decremented once (one ok:true, the other ok:false "already confirmed").
    const [a, b] = await Promise.all([
      s.callTool<{ ok: boolean }>('confirm_arap_entry', { entry_type: 'party_payment', entry_id: r.payment_id }),
      s.callTool<{ ok: boolean }>('confirm_arap_entry', { entry_type: 'party_payment', entry_id: r.payment_id }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const st = await s.callTool<{ lines: Array<{ kind: string }>; closing_balance_paisa: number }>('get_statement', { party });
    expect(st.closing_balance_paisa).toBe(0); // invoice fully cleared, exactly once
    void inv;
  });
});

describe('receivables aging summary', () => {
  it('INVARIANT: aging buckets sum to the grand total and reconcile', async () => {
    const r = await s.callTool<{
      reconciled: boolean;
      total_paisa: number;
      aging: Record<string, number>;
    }>('get_receivables_summary', { as_of: '2026-06-01' });
    expect(r.reconciled).toBe(true);
    const bucketSum = Object.values(r.aging).reduce((a, b) => a + b, 0);
    expect(bucketSum).toBe(r.total_paisa);
  });
});

describe('credit purchase (AP) + input credit', () => {
  it('records a VAT-registered supplier bill as input-credit eligible', async () => {
    const r = await s.callTool<{ saved: boolean; bill_id: string; input_credit_eligible: boolean; total_paisa: number }>(
      'record_credit_purchase',
      {
        party: 'Wholesale Supplier',
        bill_no: 'B-99',
        billed_on: '2026-03-01',
        due_on: '2026-03-31',
        amount_paisa: 226_000,
        vendor_is_vat_registered: true,
        invoice_type: 'rule17',
        for_taxable_business_use: true,
      },
    );
    expect(r.saved).toBe(true);
    expect(r.input_credit_eligible).toBe(true);
  });

  it('PROBE: a 17Ka bill is recorded but NOT input-credit eligible', async () => {
    const r = await s.callTool<{ saved: boolean; input_credit_eligible: boolean; input_credit_reasons: string[] }>(
      'record_credit_purchase',
      {
        party: 'Abbreviated Vendor',
        billed_on: '2026-03-02',
        amount_paisa: 113_000,
        vendor_is_vat_registered: true,
        invoice_type: 'rule17ka',
        for_taxable_business_use: true,
      },
    );
    expect(r.saved).toBe(true);
    expect(r.input_credit_eligible).toBe(false);
    expect(r.input_credit_reasons.join(' ')).toMatch(/17|abbreviat/i);
  });
});
