/**
 * Per-tenant usage accounting (PRD v2.0 §7 — cost controls). Written by hisab_orch
 * in the turn path. The accumulation is an idempotent UPSERT: a turn's tokens are
 * ADDED to the (tenant, period) counter, so concurrent turns (a tenant's messages
 * are serialized, but be safe anyway) and at-least-once retries can't corrupt the
 * total — Postgres does the `+=` atomically under the PK.
 *
 * Pure cost/verdict math lives in `@hisab/shared/cost`; this module is the thin IO
 * boundary (read snapshot, record a turn, list spend). All amounts integer paisa.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { usageCounters } from './schema.js';

/** Current billing period key 'YYYY-MM' (UTC). Caller may override (BS alignment). */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** estimated cost for THIS turn, integer paisa (from estimateCostPaisa). */
  costPaisa: number;
}

export interface UsageRow {
  tenantId: string;
  period: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costPaisa: number;
  warnedAt: Date | null;
}

function toRow(r: typeof usageCounters.$inferSelect): UsageRow {
  return {
    tenantId: r.tenantId,
    period: r.period,
    turns: Number(r.turns),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costPaisa: Number(r.costPaisa),
    warnedAt: r.warnedAt,
  };
}

/**
 * Add one turn's usage to the (tenant, period) counter and return the NEW totals.
 * Atomic upsert: insert the first turn, else `+=` under the PK. Runs as hisab_orch.
 */
export async function recordUsage(
  db: Db,
  tenantId: string,
  usage: TurnUsage,
  period: string = currentPeriod(),
): Promise<UsageRow> {
  const input = BigInt(Math.max(0, Math.trunc(usage.inputTokens)));
  const output = BigInt(Math.max(0, Math.trunc(usage.outputTokens)));
  const cost = BigInt(Math.max(0, Math.trunc(usage.costPaisa)));
  const [row] = await db
    .insert(usageCounters)
    .values({
      tenantId,
      period,
      turns: 1n,
      inputTokens: input,
      outputTokens: output,
      costPaisa: cost,
    })
    .onConflictDoUpdate({
      target: [usageCounters.tenantId, usageCounters.period],
      set: {
        turns: sql`${usageCounters.turns} + 1`,
        inputTokens: sql`${usageCounters.inputTokens} + ${input}`,
        outputTokens: sql`${usageCounters.outputTokens} + ${output}`,
        costPaisa: sql`${usageCounters.costPaisa} + ${cost}`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return toRow(row!);
}

/** Read a tenant's counter for a period; null if no usage yet. Runs as hisab_orch. */
export async function getUsage(
  db: Db,
  tenantId: string,
  period: string = currentPeriod(),
): Promise<UsageRow | null> {
  const rows = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.period, period)));
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Latch the soft-warn for a period: set `warnedAt` only if still null, returning
 * true when WE were the one to set it (so the owner is nudged exactly once/period).
 */
export async function markWarned(
  db: Db,
  tenantId: string,
  period: string = currentPeriod(),
): Promise<boolean> {
  const updated = await db
    .update(usageCounters)
    .set({ warnedAt: sql`now()` })
    .where(
      and(
        eq(usageCounters.tenantId, tenantId),
        eq(usageCounters.period, period),
        sql`${usageCounters.warnedAt} IS NULL`,
      ),
    )
    .returning({ tenantId: usageCounters.tenantId });
  return updated.length > 0;
}

/** Spend dashboard: all tenants' usage for a period, costliest first. hisab_orch. */
export async function getTenantSpend(db: Db, period: string = currentPeriod()): Promise<UsageRow[]> {
  const rows = await db
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.period, period))
    .orderBy(desc(usageCounters.costPaisa));
  return rows.map(toRow);
}
