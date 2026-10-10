/**
 * A correction replaces the agent's own draft (Rehearsal Lab finding #4).
 * Before: re-drafting a corrected bill flagged the new draft as a DUPLICATE of the
 * agent's own old draft. Now `supersedes_entry_id` marks the old draft superseded
 * in the same tx, and duplicate checks / listings / reports ignore it.
 * Probes: cannot supersede a CONFIRMED entry, another business's draft, or an
 * entry of the other kind; a failed validation supersedes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { adToBs } from '@hisab/shared';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;
const BS = adToBs(TODAY);

let handle: DbHandle;
let admin: ReturnType<typeof postgres>;
let s: TestSession;
let other: TestSession;

type Exp = {
  saved: boolean;
  expense_id: string;
  reason?: string;
  superseded_draft_id?: string;
  validation?: { checks: Array<{ check: string; result: string }> };
};
const bill = (amount: number, extra: Record<string, unknown> = {}) => ({
  occurred_on: TODAY_ISO,
  vendor_name: 'Sharma Traders',
  vendor_is_vat_registered: true,
  invoice_no: 'INV-77',
  amount_paisa: amount,
  is_service: false,
  for_taxable_business_use: true,
  ...extra,
});
const statusOf = async (id: string) =>
  ((await admin`
      SELECT status FROM expenses WHERE id = ${id}`)[0] as { status: string }).status;
const dupFlag = (r: Exp) => r.validation?.checks.find((x) => x.check.includes('duplicate'))?.result;

beforeAll(async () => {
  handle = appDb();
  admin = postgres(ADMIN_URL, { max: 1 });
  s = await openSession(handle, await createTenant('Correction Pasal'));
  other = await openSession(handle, await createTenant('Other Pasal'));
});
afterAll(async () => {
  await s.close();
  await other.close();
  await handle.close();
  await admin.end({ timeout: 5 });
});

describe('supersedes_entry_id', () => {
  it('baseline (the bug): re-drafting the same bill WITHOUT supersede is flagged as a duplicate', async () => {
    const a = await s.callTool<Exp>('record_expense', bill(1130000, { invoice_no: 'INV-1' }));
    const b = await s.callTool<Exp>('record_expense', bill(1243000, { invoice_no: 'INV-1' }));
    expect(dupFlag(b)).not.toBe('pass');
    void a;
  });

  it('a correction replaces its own draft: no duplicate flag, old draft superseded, listing shows one', async () => {
    const first = await s.callTool<Exp>('record_expense', bill(2260000));
    const fixed = await s.callTool<Exp>(
      'record_expense',
      bill(2373000, { supersedes_entry_id: first.expense_id }),
    );
    expect(fixed.saved).toBe(true);
    expect(fixed.superseded_draft_id).toBe(first.expense_id);
    expect(dupFlag(fixed) ?? 'pass').toBe('pass');
    expect(await statusOf(first.expense_id)).toBe('superseded');
    const list = await s.callTool<{ items: Array<{ id: string }> }>('list_transactions', {
      bs_year: BS.year,
      bs_month: BS.month,
      type: 'expense',
    });
    const ids = list.items.map((t) => t.id);
    expect(ids).toContain(fixed.expense_id);
    expect(ids).not.toContain(first.expense_id);
    // and a superseded draft can never be confirmed
    const c = await s.callTool<{ ok: boolean }>('confirm_entry', {
      entry_type: 'expense',
      entry_id: first.expense_id,
    });
    expect(c.ok).toBe(false);
  });

  it('PROBE: a CONFIRMED entry cannot be superseded (needs a credit note) — nothing saved', async () => {
    const e = await s.callTool<Exp>('record_expense', bill(500000, { invoice_no: 'INV-C' }));
    await s.callTool('confirm_entry', { entry_type: 'expense', entry_id: e.expense_id });
    const r = await s.callTool<Exp>(
      'record_expense',
      bill(600000, { invoice_no: 'INV-C', supersedes_entry_id: e.expense_id }),
    );
    expect(r.saved).toBe(false);
    expect(await statusOf(e.expense_id)).toBe('confirmed');
  });

  it("PROBE: another business's draft cannot be superseded", async () => {
    const theirs = await other.callTool<Exp>(
      'record_expense',
      bill(700000, { invoice_no: 'INV-X' }),
    );
    const r = await s.callTool<Exp>(
      'record_expense',
      bill(700000, { invoice_no: 'INV-Y', supersedes_entry_id: theirs.expense_id }),
    );
    expect(r.saved).toBe(false);
    expect(await statusOf(theirs.expense_id)).toBe('draft');
  });

  it('PROBE: a sale id cannot supersede an expense (kind must match)', async () => {
    const sale = await s.callTool<{ sale_id: string }>('record_sale', {
      occurred_on: TODAY_ISO,
      amount_paisa: 113000,
    });
    const r = await s.callTool<Exp>(
      'record_expense',
      bill(113000, { invoice_no: 'INV-K', supersedes_entry_id: sale.sale_id }),
    );
    expect(r.saved).toBe(false);
  });

  it('PROBE: a correction that is refused (future date) supersedes NOTHING (old draft kept)', async () => {
    const first = await s.callTool<Exp>('record_expense', bill(1130000, { invoice_no: 'INV-V' }));
    const bad = await s.callTool<Exp>(
      'record_expense',
      bill(1130000, {
        invoice_no: 'INV-V',
        occurred_on: '2099-01-01',
        supersedes_entry_id: first.expense_id,
      }),
    );
    expect(bad.saved).toBe(false);
    expect(await statusOf(first.expense_id)).toBe('draft');
  });
});

describe('supersede worst cases', () => {
  it('PROBE: two concurrent corrections of the same draft → exactly one replaces it', async () => {
    const first = await s.callTool<Exp>(
      'record_expense',
      bill(3390000, { invoice_no: 'INV-RACE' }),
    );
    const [a, b] = await Promise.all([
      s.callTool<Exp>(
        'record_expense',
        bill(3503000, { invoice_no: 'INV-RACE', supersedes_entry_id: first.expense_id }),
      ),
      s.callTool<Exp>(
        'record_expense',
        bill(3616000, { invoice_no: 'INV-RACE', supersedes_entry_id: first.expense_id }),
      ),
    ]);
    expect([a.saved, b.saved].filter(Boolean)).toHaveLength(1);
    expect(await statusOf(first.expense_id)).toBe('superseded');
    const live =
      await admin`SELECT count(*)::int AS n FROM expenses WHERE invoice_no = 'INV-RACE' AND status = 'draft'`;
    expect((live[0] as { n: number }).n).toBe(1);
  });

  it('PROBE: a retried correction (same idempotency_key) replays the original — no second row, no error', async () => {
    const first = await s.callTool<Exp>(
      'record_expense',
      bill(4520000, { invoice_no: 'INV-IDEM' }),
    );
    const args = bill(4633000, {
      invoice_no: 'INV-IDEM',
      supersedes_entry_id: first.expense_id,
      idempotency_key: 'fix-INV-IDEM-1',
    });
    const r1 = await s.callTool<Exp>('record_expense', args);
    const r2 = await s.callTool<Exp & { idempotent_replay?: boolean }>('record_expense', args);
    expect(r1.saved).toBe(true);
    expect(r2.expense_id).toBe(r1.expense_id);
    const rows = await admin`SELECT count(*)::int AS n FROM expenses WHERE invoice_no = 'INV-IDEM'`;
    expect((rows[0] as { n: number }).n).toBe(2); // the superseded original + one correction
  });

  it('PROBE: a superseded draft cannot itself be superseded again (chain only from the live draft)', async () => {
    const first = await s.callTool<Exp>('record_expense', bill(5650000, { invoice_no: 'INV-CH' }));
    await s.callTool<Exp>(
      'record_expense',
      bill(5763000, { invoice_no: 'INV-CH', supersedes_entry_id: first.expense_id }),
    );
    const again = await s.callTool<Exp>(
      'record_expense',
      bill(5876000, { invoice_no: 'INV-CH', supersedes_entry_id: first.expense_id }),
    );
    expect(again.saved).toBe(false);
  });
});
