/**
 * Compliance-calendar contract tests over the REAL tenant-bound Ledger MCP. These prove the
 * agent gets authoritative dates (zero hallucination): upcoming deadlines (statutory + the
 * tenant's own open invoices), exact day counts, and holiday checks. Probes per CLAUDE.md §8.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';

let handle: DbHandle;
let tenant: string;
let s: TestSession;

beforeAll(async () => {
  handle = appDb();
  tenant = await createTenant('Calendar Pasal');
  s = await openSession(handle, tenant);
});

afterAll(async () => {
  await s.close();
  await handle.close();
});

interface DeadlinesResult {
  horizon_days: number;
  today_bs: string;
  next_three: Array<{ kind: string; due_ad: string; days_until: number }>;
  events: Array<{
    kind: string;
    title: string;
    due_ad: string;
    due_bs: string;
    days_until: number;
    ref_id?: string;
  }>;
  source: string;
}

describe('get_upcoming_deadlines', () => {
  it('always returns the statutory VAT + TDS events with exact AD+BS dates', async () => {
    const r = await s.callTool<DeadlinesResult>('get_upcoming_deadlines', { horizon_days: 45 });
    expect(r.events.some((e) => e.kind === 'vat_filing')).toBe(true);
    expect(r.events.some((e) => e.kind === 'tds_deposit')).toBe(true);
    for (const e of r.events) {
      expect(e.due_ad).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.due_bs).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(r.source).toMatch(/deterministic/i);
  });

  it('includes a confirmed open invoice due date (echoed from the tenant rows, not invented)', async () => {
    // Create + confirm a credit sale with a due date well in the future.
    const sale = await s.callTool<{ saved: boolean; invoice_id: string }>('record_credit_sale', {
      party: 'Calendar Customer',
      issued_on: '2026-03-01',
      amount_paisa: 226_000,
      due_on: '2026-03-20',
    });
    expect(sale.saved).toBe(true);
    await s.callTool('confirm_arap_entry', { entry_type: 'ar_invoice', entry_id: sale.invoice_id });

    // A horizon wide enough to include 2026-03-20 from "today".
    const r = await s.callTool<DeadlinesResult>('get_upcoming_deadlines', {
      horizon_days: 400,
      include_due_items: true,
    });
    const due = r.events.find((e) => e.kind === 'invoice_due' && e.ref_id === sale.invoice_id);
    expect(due).toBeDefined();
    expect(due!.due_ad).toBe('2026-03-20');
  });

  it('include_due_items=false omits invoice/bill due events', async () => {
    const r = await s.callTool<DeadlinesResult>('get_upcoming_deadlines', {
      horizon_days: 400,
      include_due_items: false,
    });
    expect(r.events.some((e) => e.kind === 'invoice_due' || e.kind === 'bill_due')).toBe(false);
  });
});

describe('days_until_deadline', () => {
  it('returns an exact day count and flags past dates', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000);
    const iso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    const r = await s.callTool<{ days_until: number; is_past: boolean }>('days_until_deadline', {
      target_date: iso,
    });
    expect(r.days_until).toBe(7);
    expect(r.is_past).toBe(false);

    const past = await s.callTool<{ days_until: number; is_past: boolean }>('days_until_deadline', {
      target_date: '2020-01-01',
    });
    expect(past.is_past).toBe(true);
    expect(past.days_until).toBeLessThan(0);
  });
});

describe('is_business_holiday', () => {
  it('with no configured holidays, reports not-a-known-holiday and says it never guesses', async () => {
    const r = await s.callTool<{ is_holiday: boolean; note: string }>('is_business_holiday', {
      date: '2026-03-15',
    });
    expect(r.is_holiday).toBe(false);
    expect(r.note).toMatch(/never guess|not a KNOWN holiday/i);
  });
});

describe('RBAC', () => {
  it('a viewer CAN read the calendar (generate_report capability)', async () => {
    const viewer = await openSession(handle, tenant, 'viewer');
    try {
      const r = await viewer.callTool<DeadlinesResult>('get_upcoming_deadlines', {
        horizon_days: 30,
      });
      expect(Array.isArray(r.events)).toBe(true);
    } finally {
      await viewer.close();
    }
  });
});
