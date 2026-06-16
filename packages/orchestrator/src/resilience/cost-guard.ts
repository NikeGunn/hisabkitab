/**
 * Per-tenant cost guard (P11, PRD v2.0 §7) — the IO shell around the pure
 * `@hisab/shared/cost` budget core. It is the orchestrator's spend brake:
 *
 *   BEFORE a turn  → checkBudget(): resolve the tenant's plan, read this period's
 *     usage, and project a verdict. THROTTLE means "don't start a turn"; WARN means
 *     "serve, but append a one-time nudge"; OK means full service.
 *   AFTER a turn   → recordTurnUsage(): estimate the turn's paisa cost from its
 *     token usage on the active model and accumulate it (atomic upsert).
 *
 * Plan resolution: a tenant with no subscription row defaults to the STRICTEST
 * plan (starter) — deny-by-default for cost, never unlimited. Runs as hisab_orch.
 */
import { eq } from 'drizzle-orm';
import { schema, getUsage, markWarned, recordUsage, type Db, type UsageRow } from '@hisab/db';
import { projectBudget, estimateCostPaisa, type BudgetVerdict } from '@hisab/shared';

const { subscriptions } = schema;

export interface BudgetCheck {
  verdict: BudgetVerdict;
  /** the resolved plan used for the cap. */
  plan: string;
  spentPaisa: number;
  capPaisa: number;
}

/** Token usage of one turn (subset of the session client's TurnTokenUsage). */
export interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
}

/** Resolve the tenant's billing plan code; default 'starter' (strictest). */
async function resolvePlan(db: Db, tenantId: string): Promise<string> {
  const rows = await db
    .select({ planCode: subscriptions.planCode })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId));
  return rows[0]?.planCode ?? 'starter';
}

/** Project the budget verdict for a tenant in the current period (pre-turn gate). */
export async function checkBudget(db: Db, tenantId: string, period?: string): Promise<BudgetCheck> {
  const plan = await resolvePlan(db, tenantId);
  const usage = await getUsage(db, tenantId, period);
  const proj = projectBudget(plan, {
    costPaisa: usage?.costPaisa ?? 0,
    turns: usage?.turns ?? 0,
  });
  return { verdict: proj.verdict, plan, spentPaisa: proj.spentPaisa, capPaisa: proj.capPaisa };
}

/**
 * Estimate the turn's cost on `model` and accumulate it. Returns the updated row.
 * Always called AFTER a turn (or a trivial short-circuit, with model='' / 0 tokens
 * so a trivial turn still counts toward `turns` but adds ~0 cost).
 */
export async function recordTurnUsage(
  db: Db,
  tenantId: string,
  model: string,
  tokens: TurnTokens,
  period?: string,
): Promise<UsageRow> {
  const costPaisa = estimateCostPaisa(model, tokens);
  return recordUsage(db, tenantId, { ...tokens, costPaisa }, period);
}

/** Latch the once-per-period soft-warn; true when WE set it (caller nudges owner). */
export async function latchWarn(db: Db, tenantId: string, period?: string): Promise<boolean> {
  return markWarned(db, tenantId, period);
}
