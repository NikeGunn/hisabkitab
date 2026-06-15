/**
 * Drizzle/Postgres-backed IdempotencyStore (P9, PRD v2.0 §6), bound to ONE tx so
 * the key row and the entry it guards commit (or roll back) together.
 *
 * CLAIM-FIRST (exactly-once under true concurrency). `claim` inserts the key row
 * with an empty placeholder result BEFORE the entry is produced:
 * `INSERT … ON CONFLICT (tenant_id, scope, key) DO NOTHING RETURNING`. Exactly one
 * concurrent transaction wins the insert; a competing claimer BLOCKS on the unique
 * index until the winner's tx commits, then sees 0 rows (loser) and replays via
 * `load`. `finalize` UPDATEs the winner's row with the real result. RLS scopes
 * every read/write to the current tenant; the composite PK (tenant_id, scope, key)
 * is the hard, per-tenant exactly-once backstop so one tenant's literal key can
 * never collide with another's.
 */
import { and, eq } from 'drizzle-orm';
import { schema, type Tx } from '@hisab/db';
import type { IdempotencyStore, IdempotentResult } from '@hisab/shared';

const { idempotencyKeys } = schema;

export function txIdempotencyStore(tx: Tx, tenantId: string): IdempotencyStore {
  const whereKey = (key: string, scope: string) =>
    and(
      eq(idempotencyKeys.tenantId, tenantId),
      eq(idempotencyKeys.scope, scope),
      eq(idempotencyKeys.key, key),
    );
  return {
    async load(key, scope) {
      const [row] = await tx
        .select({ result: idempotencyKeys.result })
        .from(idempotencyKeys)
        .where(whereKey(key, scope));
      return row ? (row.result as IdempotentResult) : null;
    },
    async claim(key, scope) {
      // Reserve the key with an empty placeholder; the winner finalizes it.
      const inserted = await tx
        .insert(idempotencyKeys)
        .values({ key, tenantId, scope, result: {} })
        .onConflictDoNothing({
          target: [idempotencyKeys.tenantId, idempotencyKeys.scope, idempotencyKeys.key],
        })
        .returning({ key: idempotencyKeys.key });
      return inserted.length > 0; // true = this call won the claim
    },
    async finalize(key, scope, result) {
      await tx.update(idempotencyKeys).set({ result }).where(whereKey(key, scope));
    },
  };
}
