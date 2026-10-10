import postgres from 'postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDb, type DbHandle } from '@hisab/db';
import type { Role } from '@hisab/shared';
import { buildLedgerServer } from '../src/server.js';
import { ADMIN_URL, APP_URL } from './urls.js';

/** Provision a tenant on the ADMIN connection (RLS-exempt) — mirrors onboarding. */
export async function createTenant(name: string): Promise<string> {
  const sql = postgres(ADMIN_URL, { max: 1 });
  try {
    const [row] = await sql`
      INSERT INTO tenants (business_name, pan_or_vat_no, status)
      VALUES (${name}, '301234567', 'active') RETURNING id`;
    return row!['id'] as string;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface TestSession {
  client: Client;
  callTool<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  callToolRaw(name: string, args?: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
  close(): Promise<void>;
}

let adminSql: ReturnType<typeof postgres> | undefined;

/** Record an explicit owner "yes" for the tenant (what the orchestrator does on a verified inbound yes). */
export async function ownerSaysYes(tenantId: string, waMessageId = `wamid.test.${Math.random().toString(36).slice(2)}`): Promise<void> {
  adminSql ??= postgres(ADMIN_URL, { max: 1 });
  await adminSql`
      INSERT INTO owner_approvals (tenant_id, wa_message_id) VALUES (${tenantId}, ${waMessageId})`;
}

const CONFIRM_TOOLS = new Set(['confirm_entry', 'confirm_arap_entry', 'confirm_note', 'confirm_opening_balance']);

/** Connect a real MCP client to a tenant-bound Ledger server over an in-memory pair.
 *  `role` defaults to owner (full access), or pass a role to exercise RBAC gates.
 *  `ownerApproves` (default true) records an owner "yes" right before each confirm_* call,
 *  so contract tests about OTHER behaviour model a real approved conversation; the
 *  confirm-guard tests pass `ownerApproves: false` to prove the refusal. */
export async function openSession(
  handle: DbHandle,
  tenantId: string,
  role: Role = 'owner',
  opts: { ownerApproves?: boolean } = {},
): Promise<TestSession> {
  const ownerApproves = opts.ownerApproves ?? true;
  const server = buildLedgerServer({ db: handle.db }, { tenantId, role });
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const callToolRaw = async (name: string, args: Record<string, unknown> = {}) => {
    if (ownerApproves && CONFIRM_TOOLS.has(name)) await ownerSaysYes(tenantId);
    const res = await client.callTool({ name, arguments: args });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    return { ...(res.isError !== undefined ? { isError: Boolean(res.isError) } : {}), text: first?.text ?? '' };
  };

  return {
    client,
    callToolRaw,
    async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const { isError, text } = await callToolRaw(name, args);
      if (isError) throw new Error(`tool ${name} errored: ${text}`);
      return JSON.parse(text) as T;
    },
    close: () => Promise.all([client.close(), server.close()]).then(() => undefined),
  };
}

export const appDb = (): DbHandle => createDb(APP_URL, 5);
