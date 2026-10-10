/**
 * Server-side confirm-before-save (Rehearsal Lab finding #1). confirm_* tools must
 * refuse unless the owner's explicit yes (owner_approvals, written by the
 * orchestrator from verified WhatsApp text) is NEWER than the draft and fresh.
 * Probes: no approval, approval older than the draft, stale approval, other
 * tenant's approval — all refused; the draft stays a draft.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, ownerSaysYes, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;

let handle: DbHandle;
let admin: ReturnType<typeof postgres>;
let tenantId: string;
let otherTenant: string;
let s: TestSession;

beforeAll(async () => {
  handle = appDb();
  admin = postgres(ADMIN_URL, { max: 1 });
  tenantId = await createTenant('Guard Traders');
  otherTenant = await createTenant('Other Traders');
  s = await openSession(handle, tenantId, 'owner', { ownerApproves: false });
});

afterAll(async () => {
  await s.close();
  await handle.close();
  await admin.end({ timeout: 5 });
});

async function draftSale(): Promise<string> {
  const r = await s.callTool<{ sale_id: string }>('record_sale', {
    occurred_on: TODAY_ISO,
    amount_paisa: 113000,
  });
  return r.sale_id;
}
const status = async (id: string) =>
  ((await admin`
      SELECT status FROM sales WHERE id = ${id}`)[0] as { status: string }).status;

describe("confirm_entry requires the owner's yes AFTER the draft", () => {
  it('PROBE: no approval at all → refused, still a draft', async () => {
    const id = await draftSale();
    const r = await s.callTool<{ ok: boolean; needs_owner_approval?: boolean }>('confirm_entry', {
      entry_type: 'sale',
      entry_id: id,
    });
    expect(r.ok).toBe(false);
    expect(r.needs_owner_approval).toBe(true);
    expect(await status(id)).toBe('draft');
  });

  it('PROBE: a yes that came BEFORE the draft does not authorize it (agent drafted + confirmed in one turn)', async () => {
    await ownerSaysYes(tenantId);
    const id = await draftSale();
    const r = await s.callTool<{ ok: boolean }>('confirm_entry', {
      entry_type: 'sale',
      entry_id: id,
    });
    expect(r.ok).toBe(false);
    expect(await status(id)).toBe('draft');
  });

  it('PROBE: a stale yes (> 30 min old) is refused', async () => {
    // own tenant so no fresher approval from another test can leak in
    const t = await createTenant('Stale Traders');
    const st = await openSession(handle, t, 'owner', { ownerApproves: false });
    const { sale_id: id } = await st.callTool<{ sale_id: string }>('record_sale', {
      occurred_on: TODAY_ISO,
      amount_paisa: 113000,
    });
    await admin`
      UPDATE sales SET created_at = now() - interval '2 hours' WHERE id = ${id}`;
    await admin`
      INSERT INTO owner_approvals (tenant_id, wa_message_id, approved_at) VALUES (${t}, 'wamid.stale', now() - interval '31 minutes')`;
    const r = await st.callTool<{ ok: boolean }>('confirm_entry', {
      entry_type: 'sale',
      entry_id: id,
    });
    expect(r.ok).toBe(false);
    await admin`
      INSERT INTO owner_approvals (tenant_id, wa_message_id) VALUES (${t}, 'wamid.fresh')`;
    expect(
      (await st.callTool<{ ok: boolean }>('confirm_entry', { entry_type: 'sale', entry_id: id }))
        .ok,
    ).toBe(true);
    await st.close();
  });

  it("PROBE: another business's yes never authorizes this business", async () => {
    const id = await draftSale();
    await ownerSaysYes(otherTenant);
    const r = await s.callTool<{ ok: boolean }>('confirm_entry', {
      entry_type: 'sale',
      entry_id: id,
    });
    expect(r.ok).toBe(false);
  });

  it('happy path: draft → owner says yes → confirmed', async () => {
    const id = await draftSale();
    await ownerSaysYes(tenantId);
    const r = await s.callTool<{ ok: boolean; status: string }>('confirm_entry', {
      entry_type: 'sale',
      entry_id: id,
    });
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
  });

  it('the guard covers AR/AP too (confirm_arap_entry)', async () => {
    const inv = await s.callTool<{ invoice_id: string }>('record_credit_sale', {
      party: 'Guard Customer',
      issued_on: TODAY_ISO,
      due_on: TODAY_ISO,
      amount_paisa: 113000,
    });
    const refused = await s.callTool<{ ok: boolean }>('confirm_arap_entry', {
      entry_type: 'ar_invoice',
      entry_id: inv.invoice_id,
    });
    expect(refused.ok).toBe(false);
    await ownerSaysYes(tenantId);
    const ok = await s.callTool<{ ok: boolean }>('confirm_arap_entry', {
      entry_type: 'ar_invoice',
      entry_id: inv.invoice_id,
    });
    expect(ok.ok).toBe(true);
  });

  it("PROBE: the app role (the model's side) cannot write an approval itself", async () => {
    const appSql = postgres(
      process.env['TEST_DATABASE_URL'] ??
        'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab_test',
      { max: 1 },
    );
    await expect(
      appSql`
      INSERT INTO owner_approvals (tenant_id, wa_message_id) VALUES (${tenantId}, 'forged')`,
    ).rejects.toThrow(/permission denied/);
    await appSql.end({ timeout: 5 });
  });
});

describe('worst cases', () => {
  it('PROBE: 6 parallel confirms of one approved draft → exactly ONE succeeds (no double save)', async () => {
    const id = await draftSale();
    await ownerSaysYes(tenantId);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        s.callTool<{ ok: boolean }>('confirm_entry', { entry_type: 'sale', entry_id: id }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await status(id)).toBe('confirmed');
  });

  it('PROBE: one yes cannot authorize a draft created after it, even within the 30-minute window', async () => {
    await ownerSaysYes(tenantId);
    const later = await draftSale();
    expect(
      (await s.callTool<{ ok: boolean }>('confirm_entry', { entry_type: 'sale', entry_id: later }))
        .ok,
    ).toBe(false);
  });

  it('PROBE: a confirmed entry cannot be confirmed again (approval does not re-open anything)', async () => {
    const id = await draftSale();
    await ownerSaysYes(tenantId);
    expect(
      (await s.callTool<{ ok: boolean }>('confirm_entry', { entry_type: 'sale', entry_id: id })).ok,
    ).toBe(true);
    await ownerSaysYes(tenantId);
    expect(
      (await s.callTool<{ ok: boolean }>('confirm_entry', { entry_type: 'sale', entry_id: id })).ok,
    ).toBe(false);
  });
});
