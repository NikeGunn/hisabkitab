import postgres from 'postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDb, type DbHandle } from '@hisab/db';
import type { Role } from '@hisab/shared';
import { buildPaymentsServer } from '../src/server.js';
import { KhaltiClient } from '../src/khalti.js';
import type { KhaltiStub } from '../src/khalti-stub.js';
import { ADMIN_URL, APP_URL } from './urls.js';

export const STUB_SECRET = 'test-khalti-secret';

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

/** Connect a real MCP client to a tenant-bound Payments server over an in-memory pair. */
export async function openSession(
  handle: DbHandle,
  tenantId: string,
  stub: KhaltiStub,
  opts: { live?: boolean; role?: Role } = {},
): Promise<TestSession> {
  const server = buildPaymentsServer({
    db: handle.db,
    tenantId,
    role: opts.role ?? 'owner',
    khalti: new KhaltiClient({ secretKey: STUB_SECRET, origin: stub.origin }),
    returnUrl: 'http://127.0.0.1:9/payments/khalti/return', // unused in tool tests
    websiteUrl: 'https://hisabkitab.example',
    ...(opts.live !== undefined ? { live: opts.live } : {}),
  });
  const client = new Client({ name: 'payments-contract-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const callToolRaw = async (name: string, args: Record<string, unknown> = {}) => {
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
