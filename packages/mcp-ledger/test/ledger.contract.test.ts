/**
 * Contract tests: a real MCP client calling the tenant-bound Ledger server against
 * real Postgres (as hisab_app, RLS enforced). Includes the adversarial probes
 * required by CLAUDE.md §8 — wrong inputs MUST be caught, never saved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { adToBs } from '@hisab/shared';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

// All entries land in "today's" BS month so generate_return_summary sees them.
const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;
const BS_NOW = adToBs(TODAY);

let handle: DbHandle;
let session: TestSession;
let tenantId: string;

beforeAll(async () => {
  handle = appDb();
  tenantId = await createTenant('Karki Cafe');
  session = await openSession(handle, tenantId);
});

afterAll(async () => {
  await session.close();
  await handle.close();
});

describe('compute_vat (pure)', () => {
  it('splits inclusive 9,040 into 8,000 + 1,040', async () => {
    const r = await session.callTool('compute_vat', { amount_paisa: 904000, inclusive: true });
    expect(r).toEqual({ excl_paisa: 800000, vat_paisa: 104000 });
  });

  it('adds 13% to an exclusive amount', async () => {
    const r = await session.callTool('compute_vat', { amount_paisa: 800000, inclusive: false });
    expect(r).toEqual({ excl_paisa: 800000, vat_paisa: 104000 });
  });
});

describe('draft → confirm lifecycle', () => {
  let saleId: string;

  it('record_sale saves a DRAFT and states its VAT assumption', async () => {
    const r = await session.callTool<{
      saved: boolean;
      sale_id: string;
      status: string;
      amount_excl_vat_paisa: number;
      vat_paisa: number;
      assumption: string;
    }>('record_sale', { occurred_on: TODAY_ISO, description: 'catering', amount_paisa: 904000 });
    expect(r.saved).toBe(true);
    expect(r.status).toBe('draft');
    expect(r.amount_excl_vat_paisa).toBe(800000);
    expect(r.vat_paisa).toBe(104000);
    expect(r.assumption).toContain('INCLUSIVE');
    saleId = r.sale_id;
  });

  it('the return summary counts ONLY confirmed entries (draft invisible)', async () => {
    const r = await session.callTool<{ sale_count: number; output_vat_paisa: number; is_nil: boolean }>(
      'generate_return_summary',
      { bs_year: BS_NOW.year, bs_month: BS_NOW.month },
    );
    expect(r.sale_count).toBe(0);
    expect(r.output_vat_paisa).toBe(0);
    expect(r.is_nil).toBe(true);
  });

  it('confirm_entry flips draft → confirmed; summary now includes it', async () => {
    const c = await session.callTool<{ ok: boolean }>('confirm_entry', { entry_type: 'sale', entry_id: saleId });
    expect(c.ok).toBe(true);
    const r = await session.callTool<{ sale_count: number; output_vat_paisa: number; is_nil: boolean; net_payable_paisa: number }>(
      'generate_return_summary',
      { bs_year: BS_NOW.year, bs_month: BS_NOW.month },
    );
    expect(r.sale_count).toBe(1);
    expect(r.output_vat_paisa).toBe(104000);
    expect(r.net_payable_paisa).toBe(104000);
    expect(r.is_nil).toBe(false);
  });

  it('PROBE: confirming the same entry twice is rejected', async () => {
    const c = await session.callTool<{ ok: boolean; reason?: string }>('confirm_entry', {
      entry_type: 'sale',
      entry_id: saleId,
    });
    expect(c.ok).toBe(false);
  });
});

describe('record_expense — input credit + TDS', () => {
  it('a clean Rule 17 service bill earns input credit and 1.5% TDS on the excl base', async () => {
    const r = await session.callTool<{
      saved: boolean;
      expense_id: string;
      input_vat_paisa: number;
      input_credit_eligible: boolean;
      tds: { applies: boolean; rate_bps?: number; tds_paisa?: number };
    }>('record_expense', {
      occurred_on: TODAY_ISO,
      vendor_name: 'Sharma Suppliers',
      vendor_is_vat_registered: true,
      invoice_no: 'SS-2001',
      invoice_type: 'rule17',
      amount_paisa: 904000,
      inclusive: true,
      is_service: true,
      for_taxable_business_use: true,
    });
    expect(r.saved).toBe(true);
    expect(r.input_credit_eligible).toBe(true);
    expect(r.input_vat_paisa).toBe(104000);
    expect(r.tds).toMatchObject({ applies: true, rate_bps: 150, tds_paisa: 12000 });

    await session.callTool('confirm_entry', { entry_type: 'expense', entry_id: r.expense_id });
    const summary = await session.callTool<{ input_vat_paisa: number; net_payable_paisa: number }>(
      'generate_return_summary',
      { bs_year: BS_NOW.year, bs_month: BS_NOW.month },
    );
    expect(summary.input_vat_paisa).toBe(104000);
    expect(summary.net_payable_paisa).toBe(0); // 104,000 output − 104,000 input
  });

  it('PROBE: a 17Ka abbreviated bill gets ZERO input credit, with reasons', async () => {
    const r = await session.callTool<{
      saved: boolean;
      input_vat_paisa: number;
      input_credit_eligible: boolean;
      input_credit_reasons: string[];
    }>('record_expense', {
      occurred_on: TODAY_ISO,
      vendor_name: 'Quick Mart',
      vendor_is_vat_registered: true,
      invoice_no: 'QM-77',
      invoice_type: 'rule17ka',
      amount_paisa: 565000,
      inclusive: true,
      is_service: false,
      for_taxable_business_use: true,
    });
    expect(r.saved).toBe(true); // saved as draft, but credit denied
    expect(r.input_credit_eligible).toBe(false);
    expect(r.input_vat_paisa).toBe(0);
    expect(r.input_credit_reasons.join(' ')).toMatch(/17Ka/);
  });

  it('PROBE: re-recording the same vendor+invoice is flagged as a duplicate', async () => {
    const r = await session.callTool<{
      saved: boolean;
      validation: { overall: string; checks: Array<{ check: string; result: string }> };
    }>('record_expense', {
      occurred_on: TODAY_ISO,
      vendor_name: 'sharma  SUPPLIERS', // case/whitespace must not hide the duplicate
      vendor_is_vat_registered: true,
      invoice_no: 'ss-2001',
      invoice_type: 'rule17',
      amount_paisa: 904000,
      inclusive: true,
      is_service: true,
      for_taxable_business_use: true,
    });
    const dup = r.validation.checks.find((c) => c.check === 'duplicate');
    expect(dup?.result).toBe('warn');
  });

  it('PROBE: zod rejects negative/zero amounts at the boundary (never reaches the DB)', async () => {
    const raw = await session.callToolRaw('record_expense', {
      occurred_on: TODAY_ISO,
      vendor_is_vat_registered: true,
      amount_paisa: -904000,
      inclusive: true,
      is_service: false,
      for_taxable_business_use: true,
    });
    expect(raw.isError).toBe(true);
  });
});

describe('validate_entry (no write)', () => {
  it('PROBE: non-reconciling claimed figures are flagged', async () => {
    const r = await session.callTool<{ overall: string; checks: Array<{ check: string; result: string }> }>(
      'validate_entry',
      {
        entry_type: 'expense',
        occurred_on: TODAY_ISO,
        vendor_is_vat_registered: true,
        invoice_type: 'rule17',
        taxable_paisa: 800000,
        vat_paisa: 100000, // not 13%, and totals don't reconcile
        total_paisa: 904000,
        for_taxable_business_use: true,
      },
    );
    expect(r.overall).not.toBe('pass');
    const flagged = r.checks.filter((c) => c.result !== 'pass').map((c) => c.check);
    expect(flagged).toContain('vat.math');
    expect(flagged).toContain('vat.totals');
  });

  it('echoes the validated figures back (Audit Gate evidence for pre-save echoes)', async () => {
    const r = await session.callTool<{
      overall: string;
      validated_figures: { taxable_paisa: number; vat_paisa: number; total_paisa: number };
    }>('validate_entry', {
      entry_type: 'expense',
      occurred_on: TODAY_ISO,
      vendor_is_vat_registered: true,
      invoice_type: 'rule17',
      taxable_paisa: 800000,
      vat_paisa: 104000,
      total_paisa: 904000,
      for_taxable_business_use: true,
    });
    expect(r.overall).toBe('pass');
    expect(r.validated_figures).toEqual({
      taxable_paisa: 800000,
      vat_paisa: 104000,
      total_paisa: 904000,
    });
  });
});

describe('vendors', () => {
  it('upsert then case-insensitive lookup', async () => {
    await session.callTool('upsert_vendor', { name: 'Gupta Traders', pan_vat_no: '600112233', is_vat_registered: true });
    const v = await session.callTool<{ found: boolean; is_vat_registered: boolean }>('get_vendor', { name: 'gupta traders' });
    expect(v.found).toBe(true);
    expect(v.is_vat_registered).toBe(true);

    await session.callTool('upsert_vendor', { name: 'Gupta Traders', is_vat_registered: false });
    const v2 = await session.callTool<{ found: boolean; is_vat_registered: boolean; pan_vat_no: string }>('get_vendor', {
      name: 'Gupta Traders',
    });
    expect(v2.is_vat_registered).toBe(false);
    expect(v2.pan_vat_no).toBe('600112233'); // partial upsert keeps earlier facts
  });
});

describe('mark_return_filed_by_user', () => {
  it('flips prepared → confirmed_filed_by_user exactly once', async () => {
    const summary = await session.callTool<{ return_id: string }>('generate_return_summary', {
      bs_year: BS_NOW.year,
      bs_month: BS_NOW.month,
    });
    const ok = await session.callTool<{ ok: boolean }>('mark_return_filed_by_user', { return_id: summary.return_id });
    expect(ok.ok).toBe(true);
    const again = await session.callTool<{ ok: boolean }>('mark_return_filed_by_user', { return_id: summary.return_id });
    expect(again.ok).toBe(false);
  });
});

describe('audit + validation trails', () => {
  it('every write left audit_log rows; flagged checks left validation_events', async () => {
    const sql = postgres(ADMIN_URL, { max: 1 });
    try {
      const [audit] = await sql`SELECT count(*)::int AS c FROM audit_log WHERE tenant_id = ${tenantId}`;
      const [events] = await sql`SELECT count(*)::int AS c FROM validation_events WHERE tenant_id = ${tenantId}`;
      expect(audit!['c'] as number).toBeGreaterThanOrEqual(6);
      expect(events!['c'] as number).toBeGreaterThanOrEqual(2); // 17Ka warn + duplicate warn at minimum
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
