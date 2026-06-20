/**
 * Compliance-calendar digest tests — real Postgres (hisab_orch), a capturing template sender.
 * The digest is figure-free (no money), so no self-verify; the invariants are exactly-once and
 * tenant selection. Probes per CLAUDE.md §8.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@hisab/db';
import {
  noticeTenant,
  runCalendarNoticePass,
  type DigestTemplateSender,
} from '../src/scheduler/calendar-notice-job.js';
import { adToBs } from '@hisab/shared';
import { ADMIN_URL, ORCH_URL } from './urls.js';

const adminSql = postgres(ADMIN_URL, { max: 1 });
let orch: DbHandle;

const NOW = new Date(2026, 2, 10); // 10 Mar 2026 — inside a BS month
const bsNow = adToBs(NOW);

interface Sent {
  to: string;
  template: 'deadline_digest';
  params: string[];
}
function capture(): { sender: DigestTemplateSender; sent: Sent[] } {
  const sent: Sent[] = [];
  return { sent, sender: async (to, template, params) => void sent.push({ to, template, params }) };
}

async function makeTenant(opts: { name: string; e164: string | null }): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, whatsapp_e164, status)
    VALUES (${opts.name}, '301234567', ${opts.e164}, 'active') RETURNING id`;
  return row!['id'] as string;
}

beforeAll(() => {
  orch = createDb(ORCH_URL, 5);
});
afterAll(async () => {
  await orch.close();
  await adminSql.end({ timeout: 5 });
});
beforeEach(async () => {
  // child tables before tenants (FK order). Other test files in this shared DB may have
  // left rows in any tenant-scoped table, so purge the full set, not just what this writes.
  for (const table of [
    'reminder_log',
    'payment_allocations',
    'party_payments',
    'credit_notes',
    'ar_invoices',
    'ap_bills',
    'opening_balances',
    'parties',
    'validation_events',
    'vat_returns',
    'payments',
    'audit_log',
    'expenses',
    'sales',
    'tenant_sessions',
    'pairing_codes',
    'vendors',
    'usage_counters',
    'billing_payments',
    'subscriptions',
    'deletion_log',
    'memberships',
    'users',
    'tenants',
  ]) {
    await adminSql.unsafe(`DELETE FROM ${table}`);
  }
});

describe('noticeTenant — happy path', () => {
  it('sends a figure-free digest with the upcoming statutory deadlines', async () => {
    const id = await makeTenant({ name: 'Digest Pasal', e164: '9779822222201' });
    const { sender, sent } = capture();

    const out = await noticeTenant(
      { db: orch.db, sendTemplate: sender },
      { id, whatsappE164: '9779822222201' },
      bsNow.year,
      bsNow.month,
    );

    expect(out.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe('deadline_digest');
    // param[1] is the count of upcoming items; statutory VAT/TDS guarantee at least 1
    expect(Number(sent[0]!.params[1])).toBeGreaterThan(0);
    // figure-free: the digest summary states no "Rs" money amount
    expect(sent[0]!.params.join(' ')).not.toMatch(/Rs\s?\d/);
    const log = await adminSql`SELECT kind FROM reminder_log WHERE tenant_id = ${id}`;
    expect(log[0]!['kind']).toBe('deadline_digest');
  });

  it('PROBE: a second pass in the same BS month sends NOTHING (exactly-once)', async () => {
    const id = await makeTenant({ name: 'Once Digest', e164: '9779822222202' });
    const deps = { db: orch.db, sendTemplate: capture().sender };

    const first = await noticeTenant(
      deps,
      { id, whatsappE164: '9779822222202' },
      bsNow.year,
      bsNow.month,
    );
    const cap2 = capture();
    const second = await noticeTenant(
      { ...deps, sendTemplate: cap2.sender },
      { id, whatsappE164: '9779822222202' },
      bsNow.year,
      bsNow.month,
    );

    expect(first.status).toBe('sent');
    expect(second.status).toBe('already_sent');
    expect(cap2.sent).toHaveLength(0);
  });
});

describe('runCalendarNoticePass — tenant selection', () => {
  it('skips unbound-number tenants; notices the rest', async () => {
    const ok = await makeTenant({ name: 'Has Number', e164: '9779822222210' });
    const noNumber = await makeTenant({ name: 'No Number', e164: null });

    const { sender, sent } = capture();
    const outcomes = await runCalendarNoticePass({ db: orch.db, sendTemplate: sender }, NOW);

    const by = (id: string) => outcomes.find((o) => o.tenantId === id)!;
    expect(by(ok).status).toBe('sent');
    expect(by(noNumber).status).toBe('skipped');
    expect(by(noNumber).detail).toMatch(/no WhatsApp/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('9779822222210');
  });
});
