import postgres from 'postgres';
import type { LabEvent } from '../contracts.js';
import { eventHash } from '@hisab/shared';

/** Connects as the least-privilege `hisab_lab` role: rehearsal schema only. */
export function labDb(url = process.env['LAB_DATABASE_URL']): postgres.Sql {
  if (!url) throw new Error('LAB_DATABASE_URL is not set (postgres://hisab_lab:…@host:5432/hisabkitab)');
  return postgres(url, { max: 4, onnotice: () => {} });
}

/** The chain rule lives in @hisab/shared so the admin panel verifies exactly what the worker writes. */
export { EVENT_CHAIN_GENESIS as GENESIS, verifyEventChain as verifyChain } from '@hisab/shared';

/** Insert a batch of events, continuing the chain from `prev`. Returns the new head hash. */
export async function appendEvents(tx: postgres.TransactionSql, episodeId: string, events: LabEvent[], prev: string, attempt: number): Promise<string> {
  let head = prev;
  for (const e of events) {
    const hash = eventHash(head, e);
    await tx`INSERT INTO rehearsal.events (episode_id, seq, kind, data, attempt, prev_hash, hash)
             VALUES (${episodeId}, ${e.seq}, ${e.kind}, ${tx.json(e.data as postgres.JSONValue)}, ${attempt}, ${head}, ${hash})`;
    head = hash;
  }
  return head;
}
