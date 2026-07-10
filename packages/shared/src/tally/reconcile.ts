/**
 * Independent Tally reconciliation (PURE). We never take Tally's totals on faith:
 * every figure that CAN be cross-checked IS cross-checked, exactly, with bigint
 * arithmetic. A mismatch ⇒ FAIL (the answer is held), never a silent correction.
 * When the data needed for a cross-check is absent, the result says `checked: false`
 * so the caller can degrade honestly (verified_with_warnings) — absence of evidence
 * is NEVER treated as a passed check.
 *
 * Signed space for the math: the Tally convention (debit negative) via
 * balanceToSignedPaisa, so `closing = opening + credits − debits` holds:
 * a debit movement pushes the signed balance more negative (more Dr).
 */
import { balanceToSignedPaisa } from './money.js';
import type { LedgerBalancePayload, ReceivablesPayload } from './payloads.js';

export interface ReconcileResult {
  ok: boolean;
  /** true when a real cross-check ran; false = required inputs were absent */
  checked: boolean;
  /** human-readable mismatch descriptions; empty unless ok=false */
  mismatches: string[];
}

const pass: ReconcileResult = { ok: true, checked: true, mismatches: [] };
const unchecked: ReconcileResult = { ok: true, checked: false, mismatches: [] };
const fail = (...mismatches: string[]): ReconcileResult => ({
  ok: false,
  checked: true,
  mismatches,
});

/**
 * opening + credits − debits must equal closing (signed, debit-negative space).
 * This is the control total for get_ledger_balance: all four figures come from
 * Tally, but only a self-consistent set is ever rendered.
 */
export function reconcileLedgerBalance(p: LedgerBalancePayload): ReconcileResult {
  if (p.total_debits_paisa === undefined || p.total_credits_paisa === undefined) return unchecked;
  const opening = BigInt(balanceToSignedPaisa(p.opening));
  const closing = BigInt(balanceToSignedPaisa(p.closing));
  const expected = opening + BigInt(p.total_credits_paisa) - BigInt(p.total_debits_paisa);
  if (expected !== closing) {
    return fail(
      `ledger balance does not reconcile: opening(${opening}) + credits(${p.total_credits_paisa}) − ` +
        `debits(${p.total_debits_paisa}) = ${expected}, but Tally reported closing(${closing})`,
    );
  }
  return pass;
}

/** Σ line balances must equal the report-level total Tally stated (signed, exact). */
export function reconcileReceivables(p: ReceivablesPayload): ReconcileResult {
  if (p.source_total === undefined) return unchecked;
  let sum = 0n;
  for (const line of p.lines) sum += BigInt(balanceToSignedPaisa(line.balance));
  const stated = BigInt(balanceToSignedPaisa(p.source_total));
  if (sum !== stated) {
    return fail(
      `receivables do not reconcile: Σ ${p.lines.length} line balances = ${sum} signed paisa, ` +
        `but Tally's report total is ${stated}`,
    );
  }
  return pass;
}
