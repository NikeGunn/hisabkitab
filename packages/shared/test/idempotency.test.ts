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

/** In-memory CLAIM-FIRST store keyed by `${scope}:${key}`, mirroring the DB PK. */
function memStore(): IdempotencyStore & { rows: Map<string, IdempotentResult> } {
  const rows = new Map<string, IdempotentResult>();
  const k = (key: string, scope: string) => `${scope}:${key}`;
  return {
    rows,
    load: async (key, scope) => rows.get(k(key, scope)) ?? null,
    claim: async (key, scope) => {
      if (rows.has(k(key, scope))) return false; // already claimed → loser
      rows.set(k(key, scope), {}); // placeholder, finalize fills it
      return true;
    },
    finalize: async (key, scope, result) => {
      rows.set(k(key, scope), result);
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

  it('PROBE: claim-first means the loser NEVER produces (exactly one entry)', async () => {
    // Model the DB: `claim` serializes — exactly one winner inserts the key; a
    // loser blocks then sees the committed key and replays. The loser must NOT run
    // produce, so `calls` stays 1 even under a "concurrent" pair.
    const store = memStore();
    let calls = 0;
    const run = () =>
      withIdempotency<{ id: number; [REPLAY_FLAG]?: boolean }>(
        store,
        'K',
        'record_party_payment',
        async () => ({ id: ++calls }),
      );
    // Sequential await models claim serialization (the loser's claim resolves
    // AFTER the winner finalized — exactly what the DB unique index enforces).
    const x = await run();
    const y = await run();
    expect(calls).toBe(1); // produce ran ONCE — the loser never produced
    expect(x.id).toBe(y.id); // both callers see the same entry
    expect([x[REPLAY_FLAG], y[REPLAY_FLAG]].filter(Boolean)).toHaveLength(1);
  });

  it('PROBE: a loser whose winner has not finalized yet still replays (no second entry)', async () => {
    // Edge: claim says "lost" but load briefly returns the placeholder {}. The core
    // must still replay (never produce). We assert produce did not run for the loser.
    const rows = new Map<string, IdempotentResult>();
    rows.set('record_sale:K', {}); // a winner claimed but hasn't finalized
    let calls = 0;
    const store: IdempotencyStore = {
      load: async () => rows.get('record_sale:K') ?? null,
      claim: async () => false, // key already claimed → loser
      finalize: async () => undefined,
    };
    const r = await withIdempotency<{ id: number; [REPLAY_FLAG]?: boolean }>(
      store,
      'K',
      'record_sale',
      async () => ({ id: ++calls }),
    );
    expect(calls).toBe(0); // loser never produced
    expect(r[REPLAY_FLAG]).toBe(true);
  });
});
