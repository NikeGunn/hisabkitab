import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  /** Close the underlying pool (tests / shutdown). */
  close(): Promise<void>;
}

export function createDb(url: string, maxConnections = 10): DbHandle {
  const client = postgres(url, { max: maxConnections });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Run `fn` inside ONE transaction with `app.tenant_id` set for RLS.
 * `set_config(..., true)` is transaction-local, so the setting can never leak to a
 * pooled connection serving another tenant. The tenantId MUST come from verified,
 * signed session metadata — never from tool arguments.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
