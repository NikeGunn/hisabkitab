/**
 * P13 TDS-deposit reminder tests — real Postgres (hisab_orch), the REAL ledger
 * generate_tds_summary + independent self-verification, a capturing template sender.
 * No Anthropic API, no Redis (runTdsReminderPass is driven directly).
 *
 * Invariants per CLAUDE.md §3/§8, each with an adversarial probe:
 *   - a month with withholding → tds_due_soon WITH the figure (self-verify PASS)
 *   - exactly-once: a second pass for the same month re-sends NOTHING
 *   - a NIL month (nothing withheld) is SKIPPED — no obligation, no message
 *   - self-verify HOLDS a lie: a wrong prepared TDS → figure-free nudge, number withheld
 *   - unbound-number tenants are skipped
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@hisab/db';
import { createToolHandlers, type ToolContext } from '@hisab/mcp-ledger';
import { adToBs, bsMonthRange, defaultTaxConfig } from '@hisab/shared';
import { previousBsMonth } from '../src/scheduler/reminder-job.js';
import {
  remindTenantTds,
  runTdsReminderPass,
  type TdsSummaryProvider,
  type TdsTemplateSender,
} from '../src/scheduler/tds-reminder-job.js';
import { ADMIN_URL, ORCH_URL, APP_URL } from './urls.js';

const adminSql = postgres(ADMIN_URL, { max: 1 });
let orch: DbHandle;
let app: DbHandle;

const NOW = new Date('2026-06-14T00:00:00Z');
const { bsYear, bsMonth } = previousBsMonth(adToBs(NOW));
const localIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthFrom = localIso(bsMonthRange(bsYear, bsMonth).from);

/** Real ledger generate_tds_summary as the provider (no API spend), on the RLS app role. */
function ledgerTdsProvider(): TdsSummaryProvider {
  return async (tenantId, y, m) => {
    const ctx: ToolContext = { db: app.db, tenantId, role: 'owner', cfg: defaultTaxConfig };
    const handlers = createToolHandlers(ctx);
    const r = (await handlers.generate_tds_summary({ bs_year: y, bs_month: m })) as {
      tds_withheld_paisa: number;
      is_nil: boolean;
      deposit_deadline_ad: string;
    };
    return {
      tdsWithheldPaisa: BigInt(r.tds_withheld_paisa),
      isNil: r.is_nil,
      depositDeadlineAd: r.deposit_deadline_ad,
    };
  };
}

interface Sent {
  to: string;
  template: 'tds_due_soon';
  params: string[];
}
function capture(): { sender: TdsTemplateSender; sent: Sent[] } {
  const sent: Sent[] = [];
  return { sent, sender: async (to, template, params) => void sent.push({ to, template, params }) };
}

async function makeTenant(opts: { name: string; e164: string | null }): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, whatsapp_e164, status)
    VALUES (${opts.name}, '301234567', ${opts.e164}, 'active') RETURNING id`;
  return row!['id'] as string;
}

/** Seed a CONFIRMED expense with TDS withheld in the target month. */
async function seedExpenseWithTds(tenantId: string, tdsPaisa: number): Promise<void> {
  await adminSql`
    INSERT INTO expenses (tenant_id, occurred_on, amount_excl_vat_paisa, vat_paisa, input_vat_paisa, tds_rate_bps, tds_paisa, status)
    VALUES (${tenantId}, ${monthFrom}, 1000000, 0, 0, 150, ${tdsPaisa}, 'confirmed')`;
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
  // child tables before tenants (FK order). Other test files in this DB may have left
  // vat_returns / payments / etc., so purge the full set, not just what this file writes.
  for (const table of [
    'reminder_log',
    'validation_events',
    'vat_returns',
    'payments',
    'audit_log',
    'expenses',
    'sales',
    'opening_balances',
    'tenant_sessions',
    'pairing_codes',
    'vendors',
    'usage_counters',
    'memberships',
    'users',
    'tenants',
  ]) {
    await adminSql.unsafe(`DELETE FROM ${table}`);
  }
});

describe('remindTenantTds — happy path', () => {
  it('sends tds_due_soon WITH the withheld figure when withholding exists (self-verify PASS)', async () => {
    const id = await makeTenant({ name: 'TDS Pasal', e164: '9779811111101' });
    await seedExpenseWithTds(id, 15000); // Rs 150.00 withheld
    const { sender, sent } = capture();

    const out = await remindTenantTds(
      { db: orch.db, getTdsSummary: ledgerTdsProvider(), sendTemplate: sender },
      { id, whatsappE164: '9779811111101' },
      bsYear,
      bsMonth,
    );

    expect(out.status).toBe('sent');
    expect(out.verdict).toBe('PASS');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe('tds_due_soon');
    expect(sent[0]!.params.join(' ')).toContain('150.00');
    const log =
      await adminSql`SELECT kind, verdict, net_payable_paisa FROM reminder_log WHERE tenant_id = ${id}`;
    expect(log[0]).toMatchObject({ kind: 'tds_due_soon', verdict: 'PASS' });
    expect(Number(log[0]!['net_payable_paisa'])).toBe(15000);
  });

  it('PROBE: a second pass for the same month sends NOTHING (exactly-once)', async () => {
    const id = await makeTenant({ name: 'Once TDS', e164: '9779811111102' });
    await seedExpenseWithTds(id, 15000);
    const deps = {
      db: orch.db,
      getTdsSummary: ledgerTdsProvider(),
      sendTemplate: capture().sender,
    };

    const first = await remindTenantTds(
      deps,
      { id, whatsappE164: '9779811111102' },
      bsYear,
      bsMonth,
    );
    const cap2 = capture();
    const second = await remindTenantTds(
      { ...deps, sendTemplate: cap2.sender },
      { id, whatsappE164: '9779811111102' },
      bsYear,
      bsMonth,
    );

    expect(first.status).toBe('sent');
    expect(second.status).toBe('already_sent');
    expect(cap2.sent).toHaveLength(0);
  });

  it('PROBE: a nil month (no withholding) is SKIPPED — no message', async () => {
    const id = await makeTenant({ name: 'Nil TDS', e164: '9779811111103' });
    const { sender, sent } = capture();
    const out = await remindTenantTds(
      { db: orch.db, getTdsSummary: ledgerTdsProvider(), sendTemplate: sender },
      { id, whatsappE164: '9779811111103' },
      bsYear,
      bsMonth,
    );
    expect(out.status).toBe('skipped');
    expect(sent).toHaveLength(0);
    const rows =
      await adminSql`SELECT count(*)::int AS n FROM reminder_log WHERE tenant_id = ${id}`;
    expect(rows[0]!['n']).toBe(0);
  });
});

describe('PROBE: self-verification HOLDS an unverified TDS figure', () => {
  it('a lying prepared TDS is caught → figure-free nudge, number withheld', async () => {
    const id = await makeTenant({ name: 'Liar TDS', e164: '9779811111104' });
    await seedExpenseWithTds(id, 15000); // truth: 15000 paisa

    const lyingProvider: TdsSummaryProvider = async () => ({
      tdsWithheldPaisa: 999999n, // not the real 15000
      isNil: false,
      depositDeadlineAd: '2026-07-10',
    });
    const { sender, sent } = capture();
    const out = await remindTenantTds(
      { db: orch.db, getTdsSummary: lyingProvider, sendTemplate: sender },
      { id, whatsappE164: '9779811111104' },
      bsYear,
      bsMonth,
    );

    expect(out.verdict).toBe('FAIL');
    expect(out.status).toBe('sent');
    expect(sent).toHaveLength(1);
    // the held send carries NO money figure (the dash placeholder, never 9999)
    expect(sent[0]!.params.join(' ')).not.toContain('9999');
    const log =
      await adminSql`SELECT verdict, net_payable_paisa FROM reminder_log WHERE tenant_id = ${id}`;
    expect(log[0]!['verdict']).toBe('FAIL');
    expect(log[0]!['net_payable_paisa']).toBeNull(); // never stored a wrong figure
  });
});

describe('runTdsReminderPass — tenant selection', () => {
  it('skips unbound-number tenants; reminds those with withholding', async () => {
    const ok = await makeTenant({ name: 'Has TDS', e164: '9779811111110' });
    await seedExpenseWithTds(ok, 15000);
    const noNumber = await makeTenant({ name: 'No Number', e164: null });

    const { sender, sent } = capture();
    const outcomes = await runTdsReminderPass(
      { db: orch.db, getTdsSummary: ledgerTdsProvider(), sendTemplate: sender },
      NOW,
    );

    const by = (id: string) => outcomes.find((o) => o.tenantId === id)!;
    expect(by(ok).status).toBe('sent');
    expect(by(noNumber).status).toBe('skipped');
    expect(by(noNumber).detail).toMatch(/no WhatsApp/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('9779811111110');
  });
});
