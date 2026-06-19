/**
 * P13 accounting-completeness REMAINDER contract tests over the REAL tenant-bound Ledger MCP.
 * Covers: TDS-deposit summary (figure + deadline + nil), opening balances (receivable/payable/
 * vat_credit, draft→confirm, party-shape rules), the fiscal-year carry-forward annual summary,
 * and the backdated-entry flag. Adversarial PROBES per CLAUDE.md §8 are marked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';

let handle: DbHandle;
let tenant: string;
let s: TestSession;

beforeAll(async () => {
  handle = appDb();
  tenant = await createTenant('P13b Pasal');
  s = await openSession(handle, tenant);
});

afterAll(async () => {
  await s.close();
  await handle.close();
});

interface OpeningResult {
  saved: boolean;
  reason?: string;
  opening_id: string;
  kind: string;
  status: string;
  amount_paisa: number;
  fiscal_year: number;
  party_id?: string;
}

describe('TDS deposit summary', () => {
  it('a month with no withholding is nil, with a deposit deadline', async () => {
    const r = await s.callTool<{
      tds_withheld_paisa: number;
      is_nil: boolean;
      deposit_deadline_ad: string;
      deposit_deadline_bs: string;
    }>('generate_tds_summary', { bs_year: 2082, bs_month: 4 });
    expect(r.tds_withheld_paisa).toBe(0);
    expect(r.is_nil).toBe(true);
    // due the 25th of the following BS month
    expect(r.deposit_deadline_bs).toMatch(/^2082-05-25$/);
    expect(r.deposit_deadline_ad).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('PROBE: a viewer CAN read the TDS summary (generate_report), values are figures not guesses', async () => {
    const viewer = await openSession(handle, tenant, 'viewer');
    try {
      const r = await viewer.callTool<{ is_nil: boolean }>('generate_tds_summary', {
        bs_year: 2082,
        bs_month: 5,
      });
      expect(typeof r.is_nil).toBe('boolean');
    } finally {
      await viewer.close();
    }
  });
});

describe('opening balances', () => {
  it('a vat_credit opening saves as draft and confirms', async () => {
    const o = await s.callTool<OpeningResult>('record_opening_balance', {
      kind: 'vat_credit',
      amount_paisa: 230_000,
      as_of: '2025-07-16',
      note: 'carried credit at onboarding',
    });
    expect(o.saved).toBe(true);
    expect(o.status).toBe('draft');
    expect(o.kind).toBe('vat_credit');
    const c = await s.callTool<{ ok: boolean; status: string }>('confirm_opening_balance', {
      opening_id: o.opening_id,
    });
    expect(c.ok).toBe(true);
    expect(c.status).toBe('confirmed');
  });

  it('a receivable opening requires (and records) a party', async () => {
    const party = await s.callTool<{ party_id: string }>('upsert_party', {
      name: 'Opening Debtor',
      kind: 'customer',
    });
    const o = await s.callTool<OpeningResult>('record_opening_balance', {
      kind: 'receivable',
      amount_paisa: 904_000,
      as_of: '2025-07-16',
      party_id: party.party_id,
    });
    expect(o.saved).toBe(true);
    expect(o.party_id).toBe(party.party_id);
  });

  it('PROBE: a receivable opening WITHOUT a party is REJECTED', async () => {
    const o = await s.callTool<OpeningResult>('record_opening_balance', {
      kind: 'receivable',
      amount_paisa: 100_000,
      as_of: '2025-07-16',
    });
    expect(o.saved).toBe(false);
    expect(o.reason).toMatch(/party/i);
  });

  it('PROBE: a vat_credit opening WITH a party is REJECTED', async () => {
    const party = await s.callTool<{ party_id: string }>('upsert_party', {
      name: 'Bogus Party',
      kind: 'customer',
    });
    const o = await s.callTool<OpeningResult>('record_opening_balance', {
      kind: 'vat_credit',
      amount_paisa: 100_000,
      as_of: '2025-07-16',
      party_id: party.party_id,
    });
    expect(o.saved).toBe(false);
    expect(o.reason).toMatch(/must NOT name a party/i);
  });

  it('PROBE: a zero opening is REJECTED', async () => {
    const o = await s.callTool<OpeningResult>('record_opening_balance', {
      kind: 'vat_credit',
      amount_paisa: 0,
      as_of: '2025-07-16',
    });
    expect(o.saved).toBe(false);
    expect(o.reason).toMatch(/positive/i);
  });

  it('PROBE: a viewer cannot record an opening balance (record_entry denied)', async () => {
    const viewer = await openSession(handle, tenant, 'viewer');
    try {
      const res = await viewer.callToolRaw('record_opening_balance', {
        kind: 'vat_credit',
        amount_paisa: 100_000,
        as_of: '2025-07-16',
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/role|permission|denied|cannot/i);
    } finally {
      await viewer.close();
    }
  });
});

describe('annual summary (fiscal-year carry-forward)', () => {
  it('an empty fiscal year reconciles to all zeros over 12 months', async () => {
    const t2 = await createTenant('Annual Pasal');
    const s2 = await openSession(handle, t2);
    try {
      const r = await s2.callTool<{
        fiscal_year: number;
        months: unknown[];
        total_output_vat_paisa: number;
        total_net_payable_paisa: number;
        closing_carry_forward_paisa: number;
      }>('get_annual_summary', { fiscal_year: 2082 });
      expect(r.fiscal_year).toBe(2082);
      expect(r.months.length).toBe(12);
      expect(r.total_output_vat_paisa).toBe(0);
      expect(r.total_net_payable_paisa).toBe(0);
      expect(r.closing_carry_forward_paisa).toBe(0);
    } finally {
      await s2.close();
    }
  });

  it('a confirmed vat_credit opening seeds the opening carry-forward', async () => {
    const t3 = await createTenant('Carry Pasal');
    const s3 = await openSession(handle, t3);
    try {
      const o = await s3.callTool<OpeningResult>('record_opening_balance', {
        kind: 'vat_credit',
        amount_paisa: 50_000,
        as_of: '2025-07-16',
      });
      await s3.callTool('confirm_opening_balance', { opening_id: o.opening_id });
      // as_of 2025-07-16 ≈ BS 2082-04 → FY 2082, so it seeds FY 2082's opening carry.
      const r = await s3.callTool<{
        opening_carry_forward_paisa: number;
        closing_carry_forward_paisa: number;
      }>('get_annual_summary', { fiscal_year: o.fiscal_year });
      expect(r.opening_carry_forward_paisa).toBe(50_000);
      // no output VAT all year → the credit carries straight through to the close
      expect(r.closing_carry_forward_paisa).toBe(50_000);
    } finally {
      await s3.close();
    }
  });
});

describe('backdated entries', () => {
  it('a same-day sale is NOT flagged backdated', async () => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const r = await s.callTool<{ saved: boolean; is_backdated: boolean }>('record_sale', {
      occurred_on: iso,
      amount_paisa: 113_000,
      inclusive: true,
    });
    expect(r.saved).toBe(true);
    expect(r.is_backdated).toBe(false);
  });

  it('an older-month sale IS flagged backdated with guidance', async () => {
    const r = await s.callTool<{ saved: boolean; is_backdated: boolean; backdated_note?: string }>(
      'record_sale',
      {
        occurred_on: '2025-01-15',
        amount_paisa: 113_000,
        inclusive: true,
      },
    );
    expect(r.saved).toBe(true);
    expect(r.is_backdated).toBe(true);
    expect(r.backdated_note).toMatch(/earlier|re-run|generate_return_summary/i);
  });

  it('PROBE: a future-dated sale is REJECTED, nothing saved', async () => {
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const iso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    const r = await s.callTool<{ saved: boolean; reason?: string }>('record_sale', {
      occurred_on: iso,
      amount_paisa: 113_000,
      inclusive: true,
    });
    expect(r.saved).toBe(false);
    expect(r.reason).toMatch(/future/i);
  });
});
