/**
 * P10 dunning pass tests — real Postgres (hisab_orch), a capturing template sender.
 * Probes per CLAUDE.md §8:
 *   - exactly-once: a second pass on the same day re-sends NOTHING (DB latch)
 *   - auto-suspend after grace; status reconciled even with no nudge to send
 *   - never sends to a tenant with no WhatsApp number
 *   - renewal nudge only inside the window
 */
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@hisab/db';
import { addDays, GRACE_DAYS, RENEWAL_NUDGE_DAYS } from '@hisab/shared';
import { runDunningPass, type BillingTemplateSender } from '../src/scheduler/dunning-job.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

const adminSql = postgres(ADMIN_URL, { max: 1 });
let orch: DbHandle;

const NOW = new Date('2026-06-15T00:00:00Z');
const TODAY = NOW.toISOString().slice(0, 10);

interface Sent {
  to: string;
  template: string;
  params: string[];
}
function capturingSender(): { sender: BillingTemplateSender; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    sender: async (to, template, params) => {
      sent.push({ to, template, params });
    },
  };
}

async function seedSub(opts: {
  name: string;
  e164: string | null;
  plan?: string;
  status?: string;
  periodEnd: string;
}): Promise<string> {
  const [t] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, whatsapp_e164, status)
    VALUES (${opts.name}, '301234567', ${opts.e164}, 'active') RETURNING id`;
  const tid = t!['id'] as string;
  await adminSql`
    INSERT INTO subscriptions (tenant_id, plan_code, status, current_period_end)
    VALUES (${tid}, ${opts.plan ?? 'pro'}, ${opts.status ?? 'active'}, ${opts.periodEnd})`;
  return tid;
}

beforeAll(() => {
  orch = createDb(ORCH_URL, 3);
});
afterAll(async () => {
  await orch.close();
  await adminSql.end({ timeout: 5 });
});
afterEach(async () => {
  // clean rows between tests (subscriptions FK → tenants)
  await adminSql`DELETE FROM subscriptions`;
  await adminSql`DELETE FROM tenants WHERE pan_or_vat_no = '301234567' AND business_name LIKE 'Dun %'`;
});

describe('runDunningPass', () => {
  it('sends a renewal nudge inside the window and latches it', async () => {
    const tid = await seedSub({ name: 'Dun Renew', e164: '+9779800000001', periodEnd: addDays(TODAY, RENEWAL_NUDGE_DAYS) });
    const { sender, sent } = capturingSender();

    const out1 = await runDunningPass({ db: orch.db, sendTemplate: sender }, NOW);
    const mine = out1.find((o) => o.tenantId === tid)!;
    expect(mine.status).toBe('sent');
    expect(mine.stage).toBe('renewal_due_soon');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe('plan_renewal_notice');
    expect(sent[0]!.params[2]).toBe('4,999'); // Pro price display

    // PROBE: a second pass the same day re-sends NOTHING (latch).
    const { sender: s2, sent: sent2 } = capturingSender();
    const out2 = await runDunningPass({ db: orch.db, sendTemplate: s2 }, NOW);
    expect(out2.find((o) => o.tenantId === tid)!.status).toBe('skipped');
    expect(sent2).toHaveLength(0);
  });

  it('moves a lapsed sub to past_due with an "expired" nudge', async () => {
    const tid = await seedSub({ name: 'Dun Lapsed', e164: '+9779800000002', periodEnd: addDays(TODAY, -1) });
    const { sender, sent } = capturingSender();
    const out = await runDunningPass({ db: orch.db, sendTemplate: sender }, NOW);
    const mine = out.find((o) => o.tenantId === tid)!;
    expect(mine.stage).toBe('expired');
    expect(mine.newStatus).toBe('past_due');
    expect(sent[0]!.template).toBe('plan_ended_notice');
    const [row] = await adminSql`SELECT status FROM subscriptions WHERE tenant_id = ${tid}`;
    expect(row!['status']).toBe('past_due');
  });

  it('PROBE: auto-suspends after the grace window, retaining data', async () => {
    const tid = await seedSub({ name: 'Dun Suspend', e164: '+9779800000003', periodEnd: addDays(TODAY, -(GRACE_DAYS + 1)) });
    const { sender, sent } = capturingSender();
    const out = await runDunningPass({ db: orch.db, sendTemplate: sender }, NOW);
    expect(out.find((o) => o.tenantId === tid)!.newStatus).toBe('suspended');
    expect(sent[0]!.template).toBe('plan_paused_notice');
    const [row] = await adminSql`SELECT status FROM subscriptions WHERE tenant_id = ${tid}`;
    expect(row!['status']).toBe('suspended'); // suspended, NOT deleted
  });

  it('PROBE: never sends to a tenant with no WhatsApp number (but still reconciles status)', async () => {
    const tid = await seedSub({ name: 'Dun NoNumber', e164: null, periodEnd: addDays(TODAY, -1) });
    const { sender, sent } = capturingSender();
    const out = await runDunningPass({ db: orch.db, sendTemplate: sender }, NOW);
    expect(out.find((o) => o.tenantId === tid)!.status).toBe('no_number');
    expect(sent).toHaveLength(0);
    const [row] = await adminSql`SELECT status FROM subscriptions WHERE tenant_id = ${tid}`;
    expect(row!['status']).toBe('past_due'); // status still advanced
  });

  it('says nothing for a healthy subscription far from renewal', async () => {
    const tid = await seedSub({ name: 'Dun Healthy', e164: '+9779800000004', periodEnd: addDays(TODAY, 20) });
    const { sender, sent } = capturingSender();
    const out = await runDunningPass({ db: orch.db, sendTemplate: sender }, NOW);
    expect(out.find((o) => o.tenantId === tid)!.status).toBe('skipped');
    expect(sent).toHaveLength(0);
  });
});
