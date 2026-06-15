/**
 * Drizzle/Postgres-backed IdempotencyStore (P9, PRD v2.0 §6), bound to ONE tx so
 * the key row and the entry it guards commit (or roll back) together. `save` is
 * `INSERT … ON CONFLICT (tenant_id, scope, key) DO NOTHING RETURNING` —
 * conflict-aware, never raising, so a duplicate key cannot abort the surrounding
 * transaction. RLS scopes every read/write to the current tenant; the composite PK
 * (tenant_id, scope, key) is the hard, per-tenant exactly-once backstop so one
 * tenant's literal key can never collide with another's.
 */
import { and, eq } from 'drizzle-orm';
import { schema, type Tx } from '@hisab/db';
import type { IdempotencyStore, IdempotentResult } from '@hisab/shared';

const { idempotencyKeys } = schema;

export function txIdempotencyStore(tx: Tx, tenantId: string): IdempotencyStore {
  return {
    async load(key, scope) {
      const [row] = await tx
        .select({ result: idempotencyKeys.result })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, scope)));
      return row ? (row.result as IdempotentResult) : null;
    },
    async save(key, scope, result) {
      const inserted = await tx
        .insert(idempotencyKeys)
        .values({ key, tenantId, scope, result })
        .onConflictDoNothing({
          target: [idempotencyKeys.tenantId, idempotencyKeys.scope, idempotencyKeys.key],
        })
        .returning({ key: idempotencyKeys.key });
      return inserted.length > 0; // true = this call won the insert
    },
  };
}
