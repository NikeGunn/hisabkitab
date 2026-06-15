/**
 * Idempotent-write core (PRD v2.0 §6). Pure orchestration, no DB coupling.
 *
 * An entry-creating tool that receives a client-supplied `idempotency_key` must:
 *   1. return the ORIGINAL stored result if that key was already used, else
 *   2. run the producer (which performs the real insert) and persist its result
 *      under the key — all inside the caller's single tenant transaction, so the
 *      key and the entry commit (or roll back) together.
 *
 * To stay pure + independently testable, this module is generic over a minimal
 * `IdempotencyStore`. The ledger package supplies a drizzle-backed store bound to
 * the current tx; tests can supply an in-memory one. No key supplied → no dedupe.
 *
 * CLAIM-FIRST ordering (the exactly-once guarantee under true concurrency). We
 * reserve the key BEFORE running the producer:
 *   - `claim` does `INSERT … ON CONFLICT DO NOTHING` on the (tenant, scope, key)
 *     row. Exactly one concurrent transaction wins the insert; the others block on
 *     the unique index until the winner commits, then observe the committed key.
 *   - Only the WINNER runs `produce` (the real entry insert) and `finalize`s the
 *     stored result. A LOSER never produces, so it can never write a second entry —
 *     it loads and replays the winner's result.
 * This closes the window where two racing calls both insert before either latched
 * the key. The dominant real case is still the sequential retry (load hits on the
 * second call); claim-first also makes the truly-concurrent case exactly-once at
 * the DB level, not just under the orchestrator's per-tenant queue.
 */

/** A result a tool returns. Stored verbatim and replayed on a repeat key. */
export type IdempotentResult = Record<string, unknown>;

export interface IdempotencyStore {
  /** Return the stored result for `key` in this scope, or null if unseen. */
  load(key: string, scope: string): Promise<IdempotentResult | null>;
  /**
   * Reserve `key` BEFORE the entry is produced. Returns `true` when THIS call
   * inserted the placeholder row (the winner → it must produce + finalize), or
   * `false` when the key already existed (a concurrent/earlier call won → replay).
   * MUST be conflict-aware (never raise) so the surrounding transaction survives,
   * and MUST block a concurrent claimer until the winner commits (DB unique index).
   */
  claim(key: string, scope: string): Promise<boolean>;
  /** Persist the producer's `result` under the (already-claimed) `key`. */
  finalize(key: string, scope: string, result: IdempotentResult): Promise<void>;
}

/** Marks a returned result as a replay of an earlier identical call (no new write). */
export const REPLAY_FLAG = 'idempotent_replay';

/**
 * Run `produce` at most once per (key, scope). With no `key`, `produce` runs
 * directly (no dedupe). A replayed result carries `idempotent_replay: true` so
 * callers/agents can distinguish a fresh write from a replay (there is never a
 * second write).
 */
export async function withIdempotency<T extends IdempotentResult>(
  store: IdempotencyStore,
  key: string | undefined,
  scope: string,
  produce: () => Promise<T>,
): Promise<T> {
  if (!key) return produce();

  // Fast path: an already-finalized key (the common sequential retry) replays
  // without touching the producer at all.
  const seen = await store.load(key, scope);
  if (seen && Object.keys(seen).length > 0) return asReplay<T>(seen);

  // Reserve the key. Only the winner produces; a loser blocked here until the
  // winner committed, so its load now returns the finalized result.
  const won = await store.claim(key, scope);
  if (!won) {
    const winner = await store.load(key, scope);
    return asReplay<T>(winner ?? {});
  }

  const result = await produce();
  await store.finalize(key, scope, result);
  return result;
}

/** Annotate a stored result as a replay (additive runtime flag, same shape as T). */
function asReplay<T extends IdempotentResult>(stored: IdempotentResult): T {
  return { ...stored, [REPLAY_FLAG]: true } as unknown as T;
}
