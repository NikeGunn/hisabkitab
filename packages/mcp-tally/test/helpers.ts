/**
 * Tally contract-test helpers: real Postgres (RLS enforced via hisab_app), a real
 * MCP client over an in-memory pair, and a REAL connector loop driven by the
 * deterministic Tally simulator — the full pipeline minus the public internet.
 */
import postgres from 'postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDb, type DbHandle } from '@hisab/db';
import type { Role } from '@hisab/shared';
import {
  TallyClient,
  executeOperation,
  OperationError,
  type SimulatorHandle,
} from '@hisab/tally-connector';
import { buildTallyServer } from '../src/server.js';
import { claimJob, postResult } from '../src/connector-api.js';
import { ADMIN_URL, APP_URL, ORCH_URL } from './urls.js';

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
  callToolRaw(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }>;
  close(): Promise<void>;
}

/** Connect a real MCP client to a tenant-bound Tally server over an in-memory pair. */
export async function openSession(
  handle: DbHandle,
  tenantId: string,
  role: Role = 'owner',
): Promise<TestSession> {
  const server = buildTallyServer({ db: handle.db }, { tenantId, role });
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const callToolRaw = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    return {
      ...(res.isError !== undefined ? { isError: Boolean(res.isError) } : {}),
      text: first?.text ?? '',
    };
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
export const orchDb = (): DbHandle => createDb(ORCH_URL, 5);

export const CONNECTOR_TEST_VERSION = 'test-0.0.0';

/**
 * A REAL connector worker: claims jobs for `connectorId`, executes them against the
 * simulator through the real operation allowlist, posts real envelopes. Runs until
 * stopped — start it before tool calls that dispatch.
 */
export function startTestConnector(
  orch: DbHandle,
  connectorId: string,
  sim: SimulatorHandle,
): { stop: () => Promise<void> } {
  const client = new TallyClient({ baseUrl: sim.url, timeoutMs: 3_000 });
  let running = true;
  const loop = (async () => {
    while (running) {
      const job = await claimJob(orch.db, connectorId, 250, 50);
      if (!job) continue;
      let envelope: Record<string, unknown>;
      try {
        const result = await executeOperation(client, job.operation, job.params);
        envelope = {
          op: job.operation,
          ok: true,
          simulator: true,
          ...(result.companySourceId ? { company_source_id: result.companySourceId } : {}),
          payload: result.payload,
          connector_version: CONNECTOR_TEST_VERSION,
        };
      } catch (err) {
        envelope = {
          op: job.operation,
          ok: false,
          simulator: true,
          error: err instanceof OperationError ? err.message : String(err),
          connector_version: CONNECTOR_TEST_VERSION,
        };
      }
      await postResult(orch.db, connectorId, job.id, envelope);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}
