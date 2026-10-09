/**
 * Rehearsal event hash-chain: hash_n = sha256(hash_{n-1} + canonical({seq, kind, data})).
 * Editing, deleting, inserting or reordering any past event changes every later hash.
 * ONE definition, used by the lab worker (writes) and the admin panel (verifies).
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../audit/hash-chain.js';

export const EVENT_CHAIN_GENESIS = '0'.repeat(64);

export interface ChainEvent {
  seq: number;
  kind: string;
  data: unknown;
}

export const eventHash = (prev: string, e: ChainEvent): string =>
  createHash('sha256').update(prev + canonicalize({ seq: e.seq, kind: e.kind, data: e.data })).digest('hex');

export function verifyEventChain(rows: ReadonlyArray<ChainEvent & { prev_hash: string; hash: string }>): { ok: boolean; broken_at: number | null } {
  let prev = EVENT_CHAIN_GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== eventHash(prev, r)) return { ok: false, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, broken_at: null };
}
