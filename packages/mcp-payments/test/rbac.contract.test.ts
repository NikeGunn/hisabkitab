/**
 * Payments RBAC contract tests (PRD v2.0 §3): moving money and managing billing
 * are OWNER-ONLY, enforced server-side from the session role. The probes prove an
 * accountant/staff/viewer is refused even WITH a valid owner_approved flag — the
 * role gate fires before the consent gate, so a lower role can never charge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKhaltiStub, type KhaltiStub } from '../src/khalti-stub.js';
import { appDb, createTenant, openSession, STUB_SECRET, type TestSession } from './helpers.js';

let stub: KhaltiStub;
let handle: ReturnType<typeof appDb>;
let tenantId: string;
const sessions: Partial<Record<'owner' | 'accountant' | 'staff' | 'viewer', TestSession>> = {};

beforeAll(async () => {
  stub = await startKhaltiStub(STUB_SECRET);
  handle = appDb();
  tenantId = await createTenant('Payments RBAC Pasal');
  for (const role of ['owner', 'accountant', 'staff', 'viewer'] as const) {
    sessions[role] = await openSession(handle, tenantId, stub, { role });
  }
});

afterAll(async () => {
  await Promise.all(Object.values(sessions).map((s) => s?.close()));
  await handle.close();
  await stub.close();
});

const denied = (text: string) => /not permitted to/.test(text);

describe('move_money is owner-only', () => {
  for (const role of ['accountant', 'staff', 'viewer'] as const) {
    it(`PROBE: ${role} cannot initiate_payment even with owner_approved`, async () => {
      const r = await sessions[role]!.callToolRaw('initiate_payment', {
        amount_paisa: 500000,
        purpose: 'catering',
        owner_approved: true,
      });
      expect(r.isError).toBe(true);
      expect(denied(r.text)).toBe(true);
      expect(r.text).toMatch(new RegExp(role));
    });

    it(`PROBE: ${role} cannot refund_payment`, async () => {
      const r = await sessions[role]!.callToolRaw('refund_payment', { pidx: 'whatever', owner_approved: true });
      expect(r.isError).toBe(true);
      expect(denied(r.text)).toBe(true);
    });
  }
});

describe('manage_billing is owner-only', () => {
  for (const role of ['accountant', 'staff', 'viewer'] as const) {
    it(`PROBE: ${role} cannot initiate_subscription`, async () => {
      const r = await sessions[role]!.callToolRaw('initiate_subscription', {
        plan_code: 'pro',
        owner_approved: true,
      });
      expect(r.isError).toBe(true);
      expect(denied(r.text)).toBe(true);
    });

    it(`PROBE: ${role} cannot cancel_subscription`, async () => {
      const r = await sessions[role]!.callToolRaw('cancel_subscription', { owner_approved: true });
      expect(r.isError).toBe(true);
      expect(denied(r.text)).toBe(true);
    });
  }
});

describe('read-only listings are allowed for lower roles', () => {
  it('a viewer may list subscription plans', async () => {
    const r = await sessions.viewer!.callToolRaw('list_subscription_plans', {});
    expect(r.isError).toBeFalsy();
  });

  it('an accountant may read the subscription status', async () => {
    const r = await sessions.accountant!.callToolRaw('get_subscription_status', {});
    expect(r.isError).toBeFalsy();
  });
});
