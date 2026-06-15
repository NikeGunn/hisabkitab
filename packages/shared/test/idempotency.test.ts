/**
 * Pure unit tests for the idempotent-write core (PRD v2.0 §6). No DB — an
 * in-memory store stands in for the drizzle/Postgres one. Adversarial PROBES
 * (CLAUDE.md §8) prove `produce` runs at most once and a race never double-writes.
 */
import { describe, expect, it } from 'vitest';
import {
  withIdempotency,
  REPLAY_FLAG,
  type IdempotencyStore,
  type IdempotentResult,
} from '../src/index.js';

/** In-memory store keyed by `${scope}:${key}`, mirroring the DB PK + tenant scope. */
function memStore(): IdempotencyStore & { rows: Map<string, IdempotentResult> } {
  const rows = new Map<string, IdempotentResult>();
  const k = (key: string, scope: string) => `${scope}:${key}`;
  return {
    rows,
    load: async (key, scope) => rows.get(k(key, scope)) ?? null,
    save: async (key, scope, result) => {
      if (rows.has(k(key, scope))) return false; // conflict — DO NOTHING
      rows.set(k(key, scope), result);
      return true;
    },
  };
}

describe('withIdempotency', () => {
  it('no key → produce runs every time (no dedupe)', async () => {
    const store = memStore();
    let calls = 0;
    const run = () =>
      withIdempotency(store, undefined, 'record_sale', async () => ({ id: ++calls }));
    expect(await run()).toEqual({ id: 1 });
    expect(await run()).toEqual({ id: 2 });
    expect(store.rows.size).toBe(0);
  });

  it('same key → produce runs ONCE; replay returns the original + replay flag', async () => {
    const store = memStore();
    let calls = 0;
    const run = () => withIdempotency(store, 'K1', 'record_sale', async () => ({ id: ++calls }));
    const first = await run();
    const second = await run();
    expect(first).toEqual({ id: 1 });
    expect(second).toEqual({ id: 1, [REPLAY_FLAG]: true });
    expect(calls).toBe(1); // never produced a second entry
  });

  it('different keys are independent', async () => {
    const store = memStore();
    let calls = 0;
    const a = await withIdempotency(store, 'A', 'record_sale', async () => ({ id: ++calls }));
    const b = await withIdempotency(store, 'B', 'record_sale', async () => ({ id: ++calls }));
    expect(a).toEqual({ id: 1 });
    expect(b).toEqual({ id: 2 });
  });

  it('same key, different scope → independent (scope is part of the identity)', async () => {
    const store = memStore();
    let calls = 0;
    const a = await withIdempotency(store, 'K', 'record_sale', async () => ({ id: ++calls }));
    const b = await withIdempotency(store, 'K', 'record_expense', async () => ({ id: ++calls }));
    expect(a).toEqual({ id: 1 });
    expect(b).toEqual({ id: 2 });
  });

  it('PROBE: concurrent same-key calls produce ONE winner; the loser replays it', async () => {
    // Force a race: both calls pass `load` (empty) before either `save`s. The store
    // lets only the first `save` win; the loser must return the winner's result,
    // never its own second entry.
    const rows = new Map<string, IdempotentResult>();
    let saved = false;
    const racingStore: IdempotencyStore = {
      load: async () => (saved ? (rows.get('K') ?? null) : null),
      save: async (_key, _scope, result) => {
        if (saved) return false;
        saved = true;
        rows.set('K', result);
        return true;
      },
    };
    let calls = 0;
    const run = () =>
      withIdempotency<{ id: number; [REPLAY_FLAG]?: boolean }>(
        racingStore,
        'K',
        'record_party_payment',
        async () => ({
          id: ++calls,
        }),
      );
    const [x, y] = await Promise.all([run(), run()]);
    // Both produced locally (separate-tx reality), but exactly one is the stored winner;
    // the loser returns the winner's id flagged as a replay — callers never see two ids.
    const ids = [x.id, y.id];
    expect(new Set(ids).size).toBe(1); // identical id returned to both callers
    expect([x[REPLAY_FLAG], y[REPLAY_FLAG]].filter(Boolean)).toHaveLength(1);
  });
});
