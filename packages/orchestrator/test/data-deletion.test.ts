/**
 * Tenant data-deletion (PRD §14). A "delete my data" request must purge EVERY
 * tenant-scoped Postgres row (FK order, one transaction) + delete the Managed
 * Agents session, and leave a data-free proof in deletion_log — while never
 * touching another tenant's data (the isolation probe).
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createDb, type DbHandle } from '@hisab/db';
import { deleteTenantData } from '../src/security/data-deletion.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

const adminSql = postgres(ADMIN_URL, { max: 1 });
let orch: DbHandle;

/** Seed a tenant with at least one row in every tenant-scoped table + a session. */
async function seedFullTenant(name: string, e164: string): Promise<string> {
  const [t] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, whatsapp_e164, status)
    VALUES (${name}, '301234567', ${e164}, 'active') RETURNING id`;
  const id = t!['id'] as string;
  const [s] = await adminSql`
    INSERT INTO sales (tenant_id, occurred_on, amount_excl_vat_paisa, vat_paisa, status)
    VALUES (${id}, '2026-04-15', 800000, 104000, 'confirmed') RETURNING id`;
  await adminSql`INSERT INTO expenses (tenant_id, occurred_on, amount_excl_vat_paisa) VALUES (${id}, '2026-04-15', 50000)`;
  await adminSql`INSERT INTO vendors (tenant_id, name) VALUES (${id}, 'Acme')`;
  await adminSql`INSERT INTO vat_returns (tenant_id, bs_year, bs_month, output_vat_paisa, input_vat_paisa, net_payable_paisa, is_nil) VALUES (${id}, 2082, 1, 104000, 0, 104000, false)`;
  await adminSql`INSERT INTO validation_events (tenant_id, entry_type, entry_id, result) VALUES (${id}, 'sale', ${s!['id']}, 'pass')`;
  await adminSql`INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES (${id}, 'system', 'seed', '{}')`;
  await adminSql`INSERT INTO pairing_codes (code, tenant_id, expires_at) VALUES (${'C' + id.slice(0, 6)}, ${id}, now() + interval '1 hour')`;
  await adminSql`INSERT INTO payments (tenant_id, provider, pidx, purchase_order_id, purchase_order_name, amount_paisa) VALUES (${id}, 'khalti', ${'pidx-' + id.slice(0, 8)}, 'po', 'momo', 904000)`;
  await adminSql`INSERT INTO reminder_log (tenant_id, bs_year, bs_month, kind, verdict) VALUES (${id}, 2082, 1, 'return_prepared', 'PASS')`;
  await adminSql`INSERT INTO tenant_sessions (tenant_id, session_id, vault_id) VALUES (${id}, ${'sesn_' + id.slice(0, 8)}, ${'vault_' + id.slice(0, 8)})`;
  // P8: an owner user + membership for this tenant.
  const [u] = await adminSql`INSERT INTO users (whatsapp_e164) VALUES (${e164}) RETURNING id`;
  await adminSql`INSERT INTO memberships (user_id, tenant_id, role, status) VALUES (${u!['id']}, ${id}, 'owner', 'active')`;
  return id;
}

const TENANT_TABLES = [
  'sales', 'expenses', 'vendors', 'vat_returns', 'validation_events',
  'audit_log', 'pairing_codes', 'payments', 'reminder_log', 'tenant_sessions',
  'memberships',
];

async function rowCount(table: string, tenantId: string): Promise<number> {
  const r = await adminSql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  return r[0]!['n'] as number;
}

function mockClient(deleteImpl?: (id: string) => Promise<void>): { client: Anthropic; deleted: string[] } {
  const deleted: string[] = [];
  const client = {
    beta: {
      sessions: {
        delete: vi.fn(async (id: string) => {
          if (deleteImpl) await deleteImpl(id);
          deleted.push(id);
        }),
        archive: vi.fn(async (id: string) => {
          deleted.push(id);
        }),
      },
    },
  } as unknown as Anthropic;
  return { client, deleted };
}

beforeAll(() => {
  orch = createDb(ORCH_URL, 5);
});
afterAll(async () => {
  await orch.close();
  await adminSql.end({ timeout: 5 });
});
beforeEach(async () => {
  // memberships (in TENANT_TABLES) before users before tenants (FK order).
  for (const t of ['deletion_log', ...TENANT_TABLES, 'users', 'tenants']) {
    await adminSql.unsafe(`DELETE FROM ${t}`);
  }
});

describe('deleteTenantData', () => {
  it('purges every tenant table, deletes the session, and writes a data-free proof', async () => {
    const id = await seedFullTenant('Delete Me Pasal', '+9779800000001');
    const { client, deleted } = mockClient();

    const report = await deleteTenantData({ db: orch.db, client, reason: 'owner request' }, id);

    // every table empty for this tenant
    for (const table of TENANT_TABLES) {
      expect(await rowCount(table, id), `${table} should be empty`).toBe(0);
    }
    const tenantGone = await adminSql`SELECT count(*)::int AS n FROM tenants WHERE id = ${id}`;
    expect(tenantGone[0]!['n']).toBe(0);

    // session deleted via the API
    expect(deleted).toContain(`sesn_${id.slice(0, 8)}`);
    expect(report.sessionsDeleted).toHaveLength(1);
    expect(report.totalRows).toBeGreaterThanOrEqual(11); // tenant tables + tenant
    // the now-orphaned owner user is purged too (no other memberships)
    expect(report.rowsByTable['memberships']).toBe(1);
    expect(report.rowsByTable['users']).toBe(1);
    const usersGone = await adminSql`SELECT count(*)::int AS n FROM users WHERE whatsapp_e164 = '+9779800000001'`;
    expect(usersGone[0]!['n']).toBe(0);

    // proof exists, OUTSIDE the tenant, data-free
    const proof = await adminSql`SELECT tenant_id, reason, rows_deleted, sessions_deleted, detail FROM deletion_log WHERE tenant_id = ${id}`;
    expect(proof).toHaveLength(1);
    expect(proof[0]!['reason']).toBe('owner request');
    expect(Number(proof[0]!['rows_deleted'])).toBe(report.totalRows);
    // the proof carries counts + ids only, not the deleted business content
    expect(JSON.stringify(proof[0]!['detail'])).not.toMatch(/momo|Acme/);
  });

  it('PROBE: deleting tenant A leaves tenant B completely intact (isolation)', async () => {
    const a = await seedFullTenant('Tenant A', '+9779800000002');
    const b = await seedFullTenant('Tenant B', '+9779800000003');
    const { client } = mockClient();

    await deleteTenantData({ db: orch.db, client }, a);

    // A gone, B fully present
    expect(await rowCount('sales', a)).toBe(0);
    for (const table of TENANT_TABLES) {
      expect(await rowCount(table, b), `B.${table} must survive`).toBe(1);
    }
    const bAlive = await adminSql`SELECT count(*)::int AS n FROM tenants WHERE id = ${b}`;
    expect(bAlive[0]!['n']).toBe(1);
  });

  it('PROBE: the DB purge is all-or-nothing — a session-delete failure does NOT block it', async () => {
    const id = await seedFullTenant('Resilient Pasal', '+9779800000004');
    // session delete + archive both throw → recorded as a warning, purge proceeds
    const client = {
      beta: { sessions: {
        delete: vi.fn(async () => { throw new Error('network'); }),
        archive: vi.fn(async () => { throw new Error('network'); }),
      } },
    } as unknown as Anthropic;

    const report = await deleteTenantData({ db: orch.db, client }, id);

    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.sessionsDeleted).toHaveLength(0);
    // DB still fully purged despite the session failure
    expect(await rowCount('sales', id)).toBe(0);
    const proof = await adminSql`SELECT count(*)::int AS n FROM deletion_log WHERE tenant_id = ${id}`;
    expect(proof[0]!['n']).toBe(1);
  });
});
