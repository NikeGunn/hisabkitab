/**
 * TallyPrime integration — core domain types (PURE, no IO).
 *
 * TallyPrime is the AUTHORITATIVE source for Tally-derived records; HisabKitab reads,
 * validates and reconciles — it never invents or adjusts a figure. The first release is
 * strictly READ-ONLY: no operation in this module (or anywhere downstream) can create,
 * alter or delete a Tally voucher.
 *
 * Trust contract: every Tally answer carries ONE of these states. Only `verified` (and
 * `verified_with_warnings`, with its warnings shown) may be rendered as an authoritative
 * financial answer; every other state fails CLOSED — the owner is told what we could not
 * verify, never given a fabricated or silently-cached number.
 */

export const TALLY_TRUST_STATES = [
  'verified', // schema-valid + reconciled; safe to state as fact
  'verified_with_warnings', // valid + reconciled, but with caveats the owner must see
  'ambiguous', // more than one ledger/company matched; needs the owner's pick
  'partial', // Tally returned less than the requested range (e.g. archived years)
  'stale', // only cached data available and it is older than the freshness bound
  'unavailable', // connector offline / Tally not running / company not loaded
  'failed', // schema or reconciliation failure — NEVER render a figure from this
] as const;
export type TallyTrustState = (typeof TALLY_TRUST_STATES)[number];

/**
 * The allowlisted read-only operations. This list is enforced INDEPENDENTLY in three
 * places (defense in depth): the MCP tool layer, the job table CHECK constraint, and
 * the connector — a compromised layer still cannot widen the surface.
 */
export const TALLY_OPERATIONS = [
  'health',
  'list_companies',
  'search_ledgers',
  'get_ledger_balance',
  'get_receivables',
] as const;
export type TallyOperation = (typeof TALLY_OPERATIONS)[number];

export function isTallyOperation(op: string): op is TallyOperation {
  return (TALLY_OPERATIONS as readonly string[]).includes(op);
}

/**
 * A normalized accounting balance. Wire format is integer paisa (1 NPR = 100 paisa,
 * ≤ Number.MAX_SAFE_INTEGER — the platform-wide money convention) plus an explicit
 * side; magnitude and direction never travel as a bare signed number, so no consumer
 * can misread the sign convention.
 *
 * SIGN CONVENTION (documented + tested, see money.ts): TallyPrime XML exports balances
 * with **negative = debit, positive = credit** (Tally's internal convention). The
 * connector normalizes at the boundary; everything after speaks {paisa, side}.
 * A debtor who owes the business Rs 500 is `{ paisa: 50000, side: 'debit' }`.
 */
export interface TallyBalance {
  /** absolute magnitude in integer paisa */
  paisa: number;
  side: 'debit' | 'credit';
}

/** A ledger match candidate returned to the owner for a deterministic pick. */
export interface TallyLedgerRef {
  /** exact Tally ledger name — the stable selection identifier within a company */
  name: string;
  /** Tally group (e.g. "Sundry Debtors") — helps the owner disambiguate */
  group: string;
}
