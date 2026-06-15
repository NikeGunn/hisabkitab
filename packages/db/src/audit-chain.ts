/**
 * Chained audit-log append (PRD v2.0 §9). The ONE way to write an audit_log row,
 * so every entry is tamper-evident by construction (single source of truth).
 *
 * Atomicity: appends for a tenant must not fork the chain, so we take a per-tenant
 * transaction-scoped advisory lock before reading the chain tip and inserting. Two
 * concurrent writers for the same tenant serialize here; different tenants never
 * contend. The lock auto-releases at commit/rollback (xact-scoped).
 *
 * The hash function + canonicalisation live in @hisab/shared (pure, unit-tested);
 * this module only does the IO (lock → read tip → insert with the computed hash).
 */
import { sql } from 'drizzle-orm';
import { GENESIS_HASH, hashAuditRow, type AuditRowCore } from '@hisab/shared';
import { auditLog } from './schema.js';
import type { Tx } from './client.js';

export interface AuditAppend {
  actor: 'agent' | 'owner' | 'system';
  action: string;
  detail?: unknown;
}

/**
 * Append one row to a tenant's hash-chained audit log inside the caller's tx.
 * Returns the new row's hash. createdAt is fixed here (and hashed as integer ms)
 * so the stored timestamp and the hash agree exactly.
 */
export async function appendAudit(tx: Tx, tenantId: string, entry: AuditAppend): Promise<string> {
  // Serialize chain appends per tenant (xact-scoped advisory lock keyed by tenant).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);

  // Read this tenant's current chain tip (latest row_hash), or genesis if none.
  const tip = await tx
    .select({ rowHash: auditLog.rowHash })
    .from(auditLog)
    .where(sql`${auditLog.tenantId} = ${tenantId} and ${auditLog.rowHash} is not null`)
    .orderBy(sql`${auditLog.id} desc`)
    .limit(1);
  const prevHash = tip[0]?.rowHash ?? GENESIS_HASH;

  const createdAt = new Date();
  const core: AuditRowCore = {
    tenantId,
    actor: entry.actor,
    action: entry.action,
    detail: entry.detail ?? null,
    createdAtMs: createdAt.getTime(),
  };
  const rowHash = hashAuditRow(prevHash, core);

  await tx.insert(auditLog).values({
    tenantId,
    actor: entry.actor,
    action: entry.action,
    detail: (entry.detail ?? null) as never,
    prevHash,
    rowHash,
    createdAt,
  });
  return rowHash;
}
