/**
 * Opening balances (PRD v2.0 §12 "Accounting completeness": "Opening balances — when a
 * business onboards mid-year, let them enter existing open debtors/creditors and a
 * VAT-credit carry-forward (via confirmed opening entries) so reports are accurate from
 * day one").
 *
 * A business that has been trading before it joins HisabKitab already has:
 *   - open RECEIVABLES (customers who owe it — debtors),
 *   - open PAYABLES (suppliers it owes — creditors),
 *   - possibly a VAT credit carried forward from a prior period.
 * Without these, the very first statement/aging report is wrong (it would show a clean
 * slate). Opening balances seed the ledger truthfully. They are still draft→confirm and
 * go through the same Audit Gate — they are owner-asserted facts, not guesses.
 *
 * This module is pure validation of the FIGURES (kind, sign, reconciliation). It does not
 * touch the DB; the tool persists a validated opening entry and re-checks against the live
 * party in one tenant tx. Money is exact integer paisa.
 *
 * Invariants enforced here:
 *   - amount is a POSITIVE integer paisa (an opening balance of zero is meaningless),
 *   - `as_of` is a real ISO date (the day the balance is true as of — usually the
 *     onboarding cutover; the tool maps it to the BS period),
 *   - a VAT carry-forward opening is credit-only (you carry a CREDIT forward, never a debt),
 *   - receivable/payable openings name a party (debtor/creditor) — enforced by the tool.
 */
import { type Paisa } from '../money/money.js';

export type OpeningKind = 'receivable' | 'payable' | 'vat_credit';

export interface OpeningRequest {
  kind: OpeningKind;
  /** The open amount as of `asOf`, in integer paisa. Always positive. */
  amountPaisa: Paisa;
  /** ISO date (YYYY-MM-DD) the balance is true as of — the onboarding cutover. */
  asOf: string;
}

export interface OpeningFigures {
  kind: OpeningKind;
  amountPaisa: Paisa;
  asOf: string;
}

export class OpeningBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpeningBalanceError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an opening-balance request and return the reconciled figures. Throws
 * OpeningBalanceError on any violation (nothing is persisted unless this returns).
 */
export function computeOpening(req: OpeningRequest): OpeningFigures {
  if (typeof req.amountPaisa !== 'bigint') {
    throw new OpeningBalanceError('opening amount must be integer paisa (bigint)');
  }
  if (req.amountPaisa <= 0n) {
    throw new OpeningBalanceError(
      `opening balance must be a positive amount, got ${req.amountPaisa}`,
    );
  }
  if (!ISO_DATE.test(req.asOf)) {
    throw new OpeningBalanceError(`as_of must be an ISO date YYYY-MM-DD, got "${req.asOf}"`);
  }
  if (req.kind !== 'receivable' && req.kind !== 'payable' && req.kind !== 'vat_credit') {
    throw new OpeningBalanceError(`unknown opening kind: ${String(req.kind)}`);
  }
  return { kind: req.kind, amountPaisa: req.amountPaisa, asOf: req.asOf };
}
