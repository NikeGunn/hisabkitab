/**
 * Deterministic ledger-name resolution (PURE). The model NEVER picks among ambiguous
 * ledgers: one exact (case-insensitive) match resolves; several substring matches come
 * back as a deterministic, sorted candidate list for the OWNER to choose from; zero
 * matches is an honest "none". Never fuzzy-guesses, never auto-substitutes.
 */
import type { TallyLedgerRef } from './types.js';

export type LedgerResolution =
  | { kind: 'exact'; match: TallyLedgerRef }
  | { kind: 'ambiguous'; candidates: TallyLedgerRef[] }
  | { kind: 'none' };

const MAX_CANDIDATES = 8;

/** Case/whitespace-insensitive key for comparisons (never mutates displayed names). */
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function resolveLedgerQuery(
  query: string,
  ledgers: readonly TallyLedgerRef[],
): LedgerResolution {
  const q = norm(query);
  if (q.length === 0) return { kind: 'none' };

  const exact = ledgers.filter((l) => norm(l.name) === q);
  if (exact.length === 1) return { kind: 'exact', match: exact[0]! };
  // >1 identically-named ledgers (different groups) is still ambiguous — owner decides.

  const pool = exact.length > 1 ? exact : ledgers.filter((l) => norm(l.name).includes(q));
  if (pool.length === 0) return { kind: 'none' };
  if (pool.length === 1) return { kind: 'exact', match: pool[0]! };

  const candidates = [...pool]
    .sort((a, b) => a.name.localeCompare(b.name) || a.group.localeCompare(b.group))
    .slice(0, MAX_CANDIDATES);
  return { kind: 'ambiguous', candidates };
}
