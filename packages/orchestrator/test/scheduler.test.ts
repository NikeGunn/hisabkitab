/**
 * Phase 6 scheduler tests — real Postgres (hisab_orch), the REAL ledger
 * generate_return_summary + self-verification, a capturing template sender.
 * No Anthropic API, no Redis (runReminderPass is driven directly; BullMQ wiring
 * is covered by the verify harness against live Redis).
 *
 * Money-critical invariants per CLAUDE.md §3/§8, each with an adversarial probe:
 *   - exactly-once: a second pass for the same month re-sends NOTHING
 *   - self-verify HOLDS a lie: if the prepared net_payable disagrees with an
 *     independent recompute, numbers are withheld → figure-free vat_due_soon
 *   - nil month → return_prepared with is_nil
 *   - not-VAT / unbound-number tenants are skipped
 */
import postgres from 'postgres';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@hisab/db';
import { createToolHandlers, type ToolContext } from '@hisab/mcp-ledger';
import { defaultTaxConfig, bsMonthRange, adToBs } from '@hisab/shared';
import {
  remindTenant,
  runReminderPass,
  previousBsMonth,
  type ReturnSummaryProvider,
  type TemplateSender,
} from '../src/scheduler/reminder-job.js';
import { selfVerifyReturn } from '../src/scheduler/self-verify.js';
import { ADMIN_URL, ORCH_URL, APP_URL } from './urls.js';

const adminSql = postgres(ADMIN_URL, { max: 1 });
let orch: DbHandle; // cross-tenant reads (self-verify, tenant selection, reminder_log)
let app: DbHandle; // RLS tenant role — the ledger writes (generate_return_summary) run here

// A BS return month we control: the month BEFORE a fixed "now". runReminderPass
// derives the same month from NOW via adToBs, so remindTenant (explicit y/m) and
// runReminderPass (derived) agree.
const NOW = new Date('2026-06-14T00:00:00Z');
const { bsYear, bsMonth } = previousBsMonth(adToBs(NOW));
// LOCAL-parts ISO (matches the ledger's monthRange) — a UTC slice would shift the
// boundary a day and seed a sale just OUTSIDE the month on non-UTC machines.
const localIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthFrom = localIso(bsMonthRange(bsYear, bsMonth).from);

/** Real ledger generate_return_summary as the summary provider (no API spend).
 *  Runs on the RLS tenant role (app) exactly as the production HTTP provider does —
 *  the ledger handler wraps the write in withTenant. */
function ledgerProvider(): ReturnSummaryProvider {
  return async (tenantId, y, m) => {
    const ctx: ToolContext = { db: app.db, tenantId, role: 'owner', cfg: defaultTaxConfig };
    const handlers = createToolHandlers(ctx);
    const r = (await handlers.generate_return_summary({ bs_year: y, bs_month: m })) as {
      net_payable_paisa: number;
      is_nil: boolean;
      filing_deadline_ad: string;
    };
    return {
      netPayablePaisa: BigInt(r.net_payable_paisa),
      isNil: r.is_nil,
      filingDeadlineAd: r.filing_deadline_ad,
    };
  };
}

interface Sent {
  to: string;
  template: 'return_prepared' | 'vat_due_soon';
  params: string[];
}
function capture(): { sender: TemplateSender; sent: Sent[] } {
  const sent: Sent[] = [];
  return { sent, sender: async (to, template, params) => void sent.push({ to, template, params }) };
}

async function makeTenant(opts: { name: string; e164: string | null; vat?: boolean }): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, whatsapp_e164, vat_registered, status)
    VALUES (${opts.name}, '301234567', ${opts.e164}, ${opts.vat ?? true}, 'active') RETURNING id`;
  return row!['id'] as string;
}

/** Seed a CONFIRMED sale (so it counts toward the return) in the target month. */
async function seedSale(tenantId: string, exclPaisa: number, vatPaisa: number): Promise<void> {
  await adminSql`
    INSERT INTO sales (tenant_id, occurred_on, amount_excl_vat_paisa, vat_paisa, status)
    VALUES (${tenantId}, ${monthFrom}, ${exclPaisa}, ${vatPaisa}, 'confirmed')`;
}

beforeAll(() => {
  orch = createDb(ORCH_URL, 5);
  app = createDb(APP_URL, 5);
});
afterAll(async () => {
  await orch.close();
  await app.close();
  await adminSql.end({ timeout: 5 });
});
beforeEach(async () => {
  // clean slate each test, child tables before tenants (FK order). audit_log and
  // payments reference tenants too — generate_return_summary writes audit_log.
  for (const table of [
    'reminder_log',
    'validation_events',
    'vat_returns',
    'payments',
    'audit_log',
    'sales',
    'expenses',
    'tenant_sessions',
    'pairing_codes',
    'vendors',
    'memberships',
    'users',
    'tenants',
  ]) {
    await adminSql.unsafe(`DELETE FROM ${table}`);
  }
});

describe('remindTenant — happy path', () => {
  it('prepares + self-verifies + sends return_prepared with the net payable', async () => {
    const id = await makeTenant({ name: 'Verified Pasal', e164: '9779800000001' });
    await seedSale(id, 800000, 104000); // VAT 1,040.00
    const { sender, sent } = capture();

    const out = await remindTenant(
      { db: orch.db, getReturnSummary: ledgerProvider(), sendTemplate: sender },
      { id, whatsappE164: '9779800000001' },
      bsYear,
      bsMonth,
    );

    expect(out.status).toBe('sent');
    expect(out.kind).toBe('return_prepared');
    expect(out.verdict).toBe('PASS');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe('return_prepared');
    expect(sent[0]!.params[1]).toContain('1,040.00'); // net payable formatted
    const log = await adminSql`SELECT kind, verdict, net_payable_paisa FROM reminder_log WHERE tenant_id = ${id}`;
    expect(log[0]).toMatchObject({ kind: 'return_prepared', verdict: 'PASS' });
    expect(Number(log[0]!['net_payable_paisa'])).toBe(104000);
  });

  it('PROBE: a second pass for the same month sends NOTHING (exactly-once)', async () => {
    const id = await makeTenant({ name: 'Once Pasal', e164: '9779800000002' });
    await seedSale(id, 800000, 104000);
    const deps = { db: orch.db, getReturnSummary: ledgerProvider(), sendTemplate: capture().sender };

    const first = await remindTenant(deps, { id, whatsappE164: '9779800000002' }, bsYear, bsMonth);
    const cap2 = capture();
    const second = await remindTenant(
      { ...deps, sendTemplate: cap2.sender },
      { id, whatsappE164: '9779800000002' },
      bsYear,
      bsMonth,
    );

    expect(first.status).toBe('sent');
    expect(second.status).toBe('already_sent');
    expect(cap2.sent).toHaveLength(0);
    const rows = await adminSql`SELECT count(*)::int AS n FROM reminder_log WHERE tenant_id = ${id}`;
    expect(rows[0]!['n']).toBe(1);
  });

  it('a nil month (no confirmed entries) sends return_prepared marked nil', async () => {
    const id = await makeTenant({ name: 'Nil Pasal', e164: '9779800000003' });
    const { sender, sent } = capture();
    const out = await remindTenant(
      { db: orch.db, getReturnSummary: ledgerProvider(), sendTemplate: sender },
      { id, whatsappE164: '9779800000003' },
      bsYear,
      bsMonth,
    );
    expect(out.status).toBe('sent');
    expect(out.verdict).toBe('PASS');
    expect(sent[0]!.template).toBe('return_prepared');
    const log = await adminSql`SELECT is_nil FROM reminder_log WHERE tenant_id = ${id}`;
    expect(log[0]!['is_nil']).toBe(true);
  });
});

describe('PROBE: self-verification HOLDS unverified numbers', () => {
  it('a lying prepared net_payable is caught → figure-free vat_due_soon, numbers withheld', async () => {
    const id = await makeTenant({ name: 'Liar Pasal', e164: '9779800000004' });
    await seedSale(id, 800000, 104000); // truth: net 1,04,000 paisa

    // A provider that LIES — claims a different net than the ledger truly holds.
    const lyingProvider: ReturnSummaryProvider = async (_t, _y, _m) => ({
      netPayablePaisa: 999999n, // not the real 104000
      isNil: false,
      filingDeadlineAd: '2026-07-10',
    });
    const { sender, sent } = capture();
    const out = await remindTenant(
      { db: orch.db, getReturnSummary: lyingProvider, sendTemplate: sender },
      { id, whatsappE164: '9779800000004' },
      bsYear,
      bsMonth,
    );

    expect(out.verdict).toBe('FAIL');
    expect(out.kind).toBe('vat_due_soon'); // held: deadline nudge only
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe('vat_due_soon');
    // the held send carries NO money figure, only the month + deadline
    expect(sent[0]!.params.join(' ')).not.toContain('9999');
    const log = await adminSql`SELECT kind, verdict, net_payable_paisa FROM reminder_log WHERE tenant_id = ${id}`;
    expect(log[0]).toMatchObject({ kind: 'vat_due_soon', verdict: 'FAIL' });
    expect(log[0]!['net_payable_paisa']).toBeNull(); // never stored a wrong figure
  });

  it('PROBE: an unresolved `fail` validation in the period forces a HOLD even if totals agree', async () => {
    const id = await makeTenant({ name: 'Unresolved Pasal', e164: '9779800000005' });
    await seedSale(id, 800000, 104000);
    // an entry whose latest validation verdict is `fail`
    const [s] = await adminSql`
      INSERT INTO sales (tenant_id, occurred_on, amount_excl_vat_paisa, vat_paisa, status)
      VALUES (${id}, ${monthFrom}, 100000, 13000, 'confirmed') RETURNING id`;
    await adminSql`
      INSERT INTO validation_events (tenant_id, entry_type, entry_id, result, reason)
      VALUES (${id}, 'sale', ${s!['id']}, 'fail', 'totals do not reconcile')`;

    // truthful provider (net matches), but the unresolved fail must still HOLD
    const out = await remindTenant(
      { db: orch.db, getReturnSummary: ledgerProvider(), sendTemplate: capture().sender },
      { id, whatsappE164: '9779800000005' },
      bsYear,
      bsMonth,
    );
    expect(out.verdict).toBe('FAIL');
    expect(out.kind).toBe('vat_due_soon'); // held — no numbers stated
    // the self-verify reason (why it was held) is persisted in reminder_log.detail
    const log = await adminSql`SELECT detail FROM reminder_log WHERE tenant_id = ${id}`;
    expect(String(log[0]!['detail'])).toMatch(/unresolved/);
  });

  it('a `fail` later superseded by a `pass` is NOT held (latest verdict wins)', async () => {
    const id = await makeTenant({ name: 'Fixed Pasal', e164: '9779800000006' });
    const [s] = await adminSql`
      INSERT INTO sales (tenant_id, occurred_on, amount_excl_vat_paisa, vat_paisa, status)
      VALUES (${id}, ${monthFrom}, 800000, 104000, 'confirmed') RETURNING id`;
    await adminSql`INSERT INTO validation_events (tenant_id, entry_type, entry_id, result, created_at)
      VALUES (${id}, 'sale', ${s!['id']}, 'fail', now() - interval '1 hour')`;
    await adminSql`INSERT INTO validation_events (tenant_id, entry_type, entry_id, result, created_at)
      VALUES (${id}, 'sale', ${s!['id']}, 'pass', now())`;

    const v = await selfVerifyReturn(orch.db, id, bsYear, bsMonth, { netPayablePaisa: 104000n, isNil: false });
    expect(v.verdict).toBe('PASS');
    expect(v.recomputed.unresolvedFailCount).toBe(0);
  });
});

describe('runReminderPass — tenant selection', () => {
  it('skips non-VAT and unbound-number tenants; reminds the rest', async () => {
    const ok = await makeTenant({ name: 'Active VAT', e164: '9779800000010' });
    await seedSale(ok, 800000, 104000);
    const nonVat = await makeTenant({ name: 'Non VAT', e164: '9779800000011', vat: false });
    const noNumber = await makeTenant({ name: 'No Number', e164: null });

    const { sender, sent } = capture();
    const outcomes = await runReminderPass(
      { db: orch.db, getReturnSummary: ledgerProvider(), sendTemplate: sender },
      NOW,
    );

    const by = (id: string) => outcomes.find((o) => o.tenantId === id)!;
    expect(by(ok).status).toBe('sent');
    expect(by(nonVat).status).toBe('skipped');
    expect(by(nonVat).detail).toMatch(/not VAT/);
    expect(by(noNumber).status).toBe('skipped');
    expect(by(noNumber).detail).toMatch(/no WhatsApp/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('9779800000010');
  });
});
