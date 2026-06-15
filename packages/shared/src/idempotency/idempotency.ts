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
 * Guarantee & layering. The dominant real case is the SEQUENTIAL retry — a network
 * blip or session replay re-issues the same call moments later. Here `load` finds
 * the key and returns the stored result with ZERO second insert. That is the §6
 * promise ("a repeat with the same key returns the original result"). One tenant's
 * tool calls are also already SERIALIZED by the orchestrator's per-tenant queue, so
 * they never truly overlap. The key adds dedupe ACROSS turns/sessions/process
 * restarts, which the in-memory queue cannot.
 *
 * `save` is conflict-aware (Postgres `INSERT … ON CONFLICT DO NOTHING RETURNING`),
 * never throwing — a unique-violation would otherwise abort the whole tx and take
 * the real entry insert with it. If a rare cross-transaction race still loses the
 * `save`, we re-`load` and return the winner's result rather than the local one;
 * the global PK on `idempotency_keys` is the hard backstop.
 */

/** A result a tool returns. Stored verbatim and replayed on a repeat key. */
export type IdempotentResult = Record<string, unknown>;

export interface IdempotencyStore {
  /** Return the stored result for `key` in this scope, or null if unseen. */
  load(key: string, scope: string): Promise<IdempotentResult | null>;
  /**
   * Persist `result` under `key` if absent. Returns `true` when THIS call inserted
   * the row (the winner), `false` when the key already existed (a concurrent/earlier
   * call won). MUST be conflict-aware — never raise on an existing key — so the
   * surrounding transaction is not aborted.
   */
  save(key: string, scope: string, result: IdempotentResult): Promise<boolean>;
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

  const seen = await store.load(key, scope);
  if (seen) return asReplay<T>(seen);

  const result = await produce();
  const won = await store.save(key, scope, result);
  if (won) return result;

  // Lost the race: a concurrent call with this key committed first. Return its
  // stored result, never a second entry. (`load` after a DO-NOTHING is safe — no
  // error was raised, so the transaction is intact.)
  const winner = await store.load(key, scope);
  return asReplay<T>(winner ?? result);
}

/** Annotate a stored result as a replay (additive runtime flag, same shape as T). */
function asReplay<T extends IdempotentResult>(stored: IdempotentResult): T {
  return { ...stored, [REPLAY_FLAG]: true } as unknown as T;
}
