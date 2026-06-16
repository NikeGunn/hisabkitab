/**
 * get_cost_summary contract test (P11, PRD v2.0 §7) over the REAL tenant-bound
 * Ledger MCP + Postgres. Proves the tool reports this tenant's usage vs its plan
 * budget with the right verdict, defaults plan to starter when unsubscribed, and —
 * the PROBE — a tenant at its cap returns THROTTLE (the figure ops/agent rely on to
 * explain a usage limit). Read-only; available to any reporting role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { DbHandle } from '@hisab/db';
import { PLAN_BUDGET_PAISA } from '@hisab/shared';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

const NOW = new Date();
const PERIOD = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`;

let handle: DbHandle;
const admin = postgres(ADMIN_URL, { max: 2 });

beforeAll(() => {
  handle = appDb();
});
afterAll(async () => {
  await admin.end({ timeout: 5 });
  await handle.close();
});

interface CostSummary {
  period: string;
  plan: string;
  plan_name: string;
  turns: number;
  spent_npr: string;
  budget_npr: string;
  verdict: 'OK' | 'WARN' | 'THROTTLE';
}

async function seedUsage(tenantId: string, costPaisa: number, plan?: string): Promise<void> {
  await admin`INSERT INTO usage_counters (tenant_id, period, turns, cost_paisa) VALUES (${tenantId}, ${PERIOD}, 4, ${costPaisa})`;
  if (plan) {
    await admin`INSERT INTO subscriptions (tenant_id, plan_code, status, current_period_end) VALUES (${tenantId}, ${plan}, 'active', '2099-12-31')`;
  }
}

describe('get_cost_summary', () => {
  it('reports usage vs the plan budget with verdict OK when under', async () => {
    const tenantId = await createTenant('Cost OK Pasal');
    await seedUsage(tenantId, 5_000, 'business');
    const s: TestSession = await openSession(handle, tenantId);
    try {
      const r = await s.callTool<CostSummary>('get_cost_summary');
      expect(r.period).toBe(PERIOD);
      expect(r.plan).toBe('business');
      expect(r.plan_name).toBe('Business');
      expect(r.verdict).toBe('OK');
      expect(r.turns).toBe(4);
      expect(r.budget_npr).toBe((PLAN_BUDGET_PAISA.business / 100).toFixed(2));
      expect(r.spent_npr).toBe('50.00');
    } finally {
      await s.close();
    }
  });

  it('defaults to the starter budget when the tenant has no subscription', async () => {
    const tenantId = await createTenant('No Sub Pasal');
    await seedUsage(tenantId, 1_000);
    const s = await openSession(handle, tenantId);
    try {
      const r = await s.callTool<CostSummary>('get_cost_summary');
      expect(r.plan).toBe('starter');
      expect(r.budget_npr).toBe((PLAN_BUDGET_PAISA.starter / 100).toFixed(2));
    } finally {
      await s.close();
    }
  });

  it('PROBE: a tenant at its cap returns THROTTLE', async () => {
    const tenantId = await createTenant('Maxed Pasal');
    await seedUsage(tenantId, PLAN_BUDGET_PAISA.starter, 'starter');
    const s = await openSession(handle, tenantId);
    try {
      const r = await s.callTool<CostSummary>('get_cost_summary');
      expect(r.verdict).toBe('THROTTLE');
    } finally {
      await s.close();
    }
  });

  it('a viewer (read role) may pull the cost summary', async () => {
    const tenantId = await createTenant('Viewer Cost Pasal');
    await seedUsage(tenantId, 100, 'pro');
    const s = await openSession(handle, tenantId, 'viewer');
    try {
      const r = await s.callTool<CostSummary>('get_cost_summary');
      expect(r.verdict).toBe('OK');
    } finally {
      await s.close();
    }
  });
});
