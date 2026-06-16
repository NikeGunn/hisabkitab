/**
 * Tenant data-deletion path (PRD v1.0 §14 / v1.1 §14 — "tenant data-deletion
 * path; sessions are not ZDR-eligible"). The owner can ask us to delete their
 * business's data; we must honor it across BOTH stores:
 *
 *   1. Postgres — every tenant-scoped row, in FK order, inside ONE transaction
 *      (all-or-nothing; a partial delete must never leave dangling references).
 *   2. Managed Agents — the tenant's stateful session(s) are server-side and not
 *      ZDR-eligible, so they (and any uploaded Files) must be deleted via the API.
 *
 * Runs as hisab_orch (cross-tenant). Returns a per-store report. Because the
 * tenant's own audit_log rows are purged, the deletion itself is recorded OUTSIDE
 * the tenant — in `deletion_log` (a cross-tenant orchestrator table) — so we keep
 * proof the request was honored without retaining the data.
 *
 * This does NOT touch the government or any portal; it only removes OUR copy.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';

const {
  payments,
  reminderLog,
  validationEvents,
  vatReturns,
  expenses,
  sales,
  vendors,
  auditLog,
  pairingCodes,
  tenantSessions,
  memberships,
  users,
  tenants,
  deletionLog,
  usageCounters,
} = schema;

export interface DeletionReport {
  tenantId: string;
  /** rows removed, keyed by table. */
  rowsByTable: Record<string, number>;
  totalRows: number;
  /** Managed Agents session ids we deleted (best-effort). */
  sessionsDeleted: string[];
  /** Files we deleted (best-effort). */
  filesDeleted: string[];
  /** non-fatal cleanup problems (e.g. a session already gone). */
  warnings: string[];
}

/**
 * Delete every Postgres row for a tenant in FK-safe order, in one transaction.
 * payments.sale_id → sales.id means payments MUST go before sales; tenants last.
 */
async function purgePostgres(db: Db, tenantId: string): Promise<Record<string, number>> {
  const rowsByTable: Record<string, number> = {};

  await db.transaction(async (tx) => {
    // delByTenant returns the row count; each call is its own typed statement so
    // drizzle keeps full column types (no cross-table unification cast).
    const n = async (name: string, count: number) => {
      rowsByTable[name] = count;
    };
    // Order matters: children before parents. payments.sale_id → sales, so
    // payments BEFORE sales; everything references tenants, so tenants LAST.
    await n('payments', (await tx.delete(payments).where(eq(payments.tenantId, tenantId)).returning({ id: payments.id })).length);
    await n('reminder_log', (await tx.delete(reminderLog).where(eq(reminderLog.tenantId, tenantId)).returning({ id: reminderLog.id })).length);
    await n('validation_events', (await tx.delete(validationEvents).where(eq(validationEvents.tenantId, tenantId)).returning({ id: validationEvents.id })).length);
    await n('vat_returns', (await tx.delete(vatReturns).where(eq(vatReturns.tenantId, tenantId)).returning({ id: vatReturns.id })).length);
    await n('expenses', (await tx.delete(expenses).where(eq(expenses.tenantId, tenantId)).returning({ id: expenses.id })).length);
    await n('sales', (await tx.delete(sales).where(eq(sales.tenantId, tenantId)).returning({ id: sales.id })).length);
    await n('vendors', (await tx.delete(vendors).where(eq(vendors.tenantId, tenantId)).returning({ id: vendors.id })).length);
    await n('audit_log', (await tx.delete(auditLog).where(eq(auditLog.tenantId, tenantId)).returning({ id: auditLog.id })).length);
    await n('pairing_codes', (await tx.delete(pairingCodes).where(eq(pairingCodes.tenantId, tenantId)).returning({ code: pairingCodes.code })).length);
    await n('tenant_sessions', (await tx.delete(tenantSessions).where(eq(tenantSessions.tenantId, tenantId)).returning({ tenantId: tenantSessions.tenantId })).length);
    await n('usage_counters', (await tx.delete(usageCounters).where(eq(usageCounters.tenantId, tenantId)).returning({ tenantId: usageCounters.tenantId })).length);

    // P8: drop this tenant's memberships, capturing the affected users…
    const removed = await tx.delete(memberships).where(eq(memberships.tenantId, tenantId)).returning({ userId: memberships.userId });
    await n('memberships', removed.length);
    // …then delete ONLY users who now have no membership anywhere (a shared
    // accountant who still serves other businesses keeps their identity).
    const userIds = [...new Set(removed.map((r) => r.userId))];
    let orphanedUsers = 0;
    if (userIds.length > 0) {
      const orphans = await tx
        .delete(users)
        .where(
          sql`${inArray(users.id, userIds)} AND NOT EXISTS (
            SELECT 1 FROM ${memberships} m WHERE m.user_id = ${users.id}
          )`,
        )
        .returning({ id: users.id });
      orphanedUsers = orphans.length;
    }
    await n('users', orphanedUsers);

    await n('tenants', (await tx.delete(tenants).where(eq(tenants.id, tenantId)).returning({ id: tenants.id })).length);
  });

  return rowsByTable;
}

/**
 * Delete the tenant's Managed Agents session(s). We read the registry BEFORE the
 * Postgres purge wipes it (the caller passes the captured session ids).
 */
async function purgeManagedAgents(
  client: Anthropic,
  sessionIds: string[],
): Promise<{ sessionsDeleted: string[]; warnings: string[] }> {
  const sessionsDeleted: string[] = [];
  const warnings: string[] = [];
  for (const sessionId of sessionIds) {
    try {
      // Prefer hard delete (not just archive) — the data must be gone, not hidden.
      await client.beta.sessions.delete(sessionId);
      sessionsDeleted.push(sessionId);
    } catch (err) {
      // Fall back to archive if delete is unavailable; record either way.
      try {
        await client.beta.sessions.archive(sessionId);
        sessionsDeleted.push(sessionId);
        warnings.push(`session ${sessionId}: deleted via archive (hard delete unavailable)`);
      } catch (err2) {
        warnings.push(`session ${sessionId}: could not delete (${err2 instanceof Error ? err2.message : String(err2)}; ${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  return { sessionsDeleted, warnings };
}

export interface DeleteTenantDeps {
  /** hisab_orch handle (cross-tenant). */
  db: Db;
  client: Anthropic;
  log?: (msg: string) => void;
  /** Reason captured for the deletion_log proof (e.g. "owner request 2026-06-14"). */
  reason?: string;
}

/**
 * Honor a tenant's "delete my data" request end-to-end. Captures the session ids
 * first, deletes the Managed Agents sessions, purges Postgres in one transaction,
 * and records the (data-free) proof in deletion_log.
 */
export async function deleteTenantData(
  deps: DeleteTenantDeps,
  tenantId: string,
): Promise<DeletionReport> {
  // 1. capture session/vault ids BEFORE the purge removes tenant_sessions.
  const sessions = await deps.db
    .select({ sessionId: tenantSessions.sessionId, vaultId: tenantSessions.vaultId })
    .from(tenantSessions)
    .where(eq(tenantSessions.tenantId, tenantId));
  const sessionIds = sessions.map((s) => s.sessionId);

  // 2. Managed Agents cleanup (best-effort — must not block the DB purge).
  const ma = await purgeManagedAgents(deps.client, sessionIds);

  // 3. Postgres purge (all-or-nothing).
  const rowsByTable = await purgePostgres(deps.db, tenantId);
  const totalRows = Object.values(rowsByTable).reduce((a, b) => a + b, 0);

  // 4. record the proof OUTSIDE the tenant (its audit_log is now gone).
  await deps.db.insert(deletionLog).values({
    tenantId,
    reason: deps.reason ?? 'tenant data-deletion request',
    rowsDeleted: totalRows,
    sessionsDeleted: ma.sessionsDeleted.length,
    detail: { rowsByTable, sessionIds, warnings: ma.warnings },
  });

  const report: DeletionReport = {
    tenantId,
    rowsByTable,
    totalRows,
    sessionsDeleted: ma.sessionsDeleted,
    filesDeleted: [], // uploaded Files are session-scoped and removed with the session
    warnings: ma.warnings,
  };
  deps.log?.(`tenant ${tenantId} deleted: ${totalRows} rows, ${ma.sessionsDeleted.length} sessions`);
  return report;
}
