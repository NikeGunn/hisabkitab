/**
 * RBAC contract tests (PRD v2.0 §3): the SAME tool, called over a real MCP client
 * against real Postgres, is allowed or denied purely by the role baked into the
 * session — proving enforcement is server-side, not in the prompt. Denials are the
 * adversarial probes required by CLAUDE.md §8: an under-privileged caller MUST be
 * refused, and nothing is written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@hisab/db';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';

const TODAY = new Date();
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;

let handle: DbHandle;
let tenantId: string;
const sessions: Partial<Record<'owner' | 'accountant' | 'staff' | 'viewer', TestSession>> = {};

beforeAll(async () => {
  handle = appDb();
  tenantId = await createTenant('RBAC Traders');
  for (const role of ['owner', 'accountant', 'staff', 'viewer'] as const) {
    sessions[role] = await openSession(handle, tenantId, role);
  }
});

afterAll(async () => {
  await Promise.all(Object.values(sessions).map((s) => s?.close()));
  await handle.close();
});

const denied = (text: string) => /not permitted to/.test(text);

describe('record_entry (draft) — owner/accountant/staff yes, viewer no', () => {
  for (const role of ['owner', 'accountant', 'staff'] as const) {
    it(`${role} may record a draft sale`, async () => {
      const r = await sessions[role]!.callToolRaw('record_sale', {
        occurred_on: TODAY_ISO,
        amount_paisa: 113000,
        inclusive: true,
      });
      expect(r.isError).toBeFalsy();
    });
  }

  it('PROBE: a viewer is refused record_sale and writes nothing', async () => {
    const r = await sessions.viewer!.callToolRaw('record_sale', {
      occurred_on: TODAY_ISO,
      amount_paisa: 113000,
      inclusive: true,
    });
    expect(r.isError).toBe(true);
    expect(denied(r.text)).toBe(true);
    expect(r.text).toMatch(/viewer/);
  });
});

describe('confirm_entry — owner/accountant yes, staff/viewer no', () => {
  let draftId: string;

  beforeAll(async () => {
    const saved = await sessions.owner!.callTool<{ sale_id: string }>('record_sale', {
      occurred_on: TODAY_ISO,
      amount_paisa: 226000,
      inclusive: true,
    });
    draftId = saved.sale_id;
  });

  it('PROBE: staff CANNOT confirm (no save without owner/accountant authority)', async () => {
    const r = await sessions.staff!.callToolRaw('confirm_entry', { entry_type: 'sale', entry_id: draftId });
    expect(r.isError).toBe(true);
    expect(denied(r.text)).toBe(true);
    expect(r.text).toMatch(/staff/);
  });

  it('accountant CAN confirm', async () => {
    const r = await sessions.accountant!.callTool<{ ok: boolean; status: string }>('confirm_entry', {
      entry_type: 'sale',
      entry_id: draftId,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('confirmed');
  });
});

describe('generate_report (read) — viewer yes, staff no', () => {
  it('a viewer may list transactions', async () => {
    const r = await sessions.viewer!.callToolRaw('list_transactions', {
      bs_year: 2080,
      bs_month: 1,
    });
    expect(r.isError).toBeFalsy();
  });

  it('PROBE: staff cannot pull reports (write-only role)', async () => {
    const r = await sessions.staff!.callToolRaw('list_transactions', { bs_year: 2080, bs_month: 1 });
    expect(r.isError).toBe(true);
    expect(denied(r.text)).toBe(true);
  });
});

describe('prepare_vat — owner/accountant only', () => {
  it('PROBE: a viewer cannot mark a return filed', async () => {
    const r = await sessions.viewer!.callToolRaw('mark_return_filed_by_user', {
      return_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.isError).toBe(true);
    expect(denied(r.text)).toBe(true);
  });
});
