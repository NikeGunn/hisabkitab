/**
 * Credit / debit notes (PRD v2.0 §12 "Accounting completeness").
 *
 * A confirmed VAT invoice is IMMUTABLE — you never edit its amount. A sales return,
 * cancellation, or correction is handled by issuing a linked note that references the
 * original invoice:
 *   - a CREDIT note reduces what the customer owes (return / over-bill correction),
 *   - a DEBIT note increases it (under-bill correction).
 * Either way the note carries its own taxable + VAT split so the VAT return nets out
 * correctly, and the audit trail stays intact (original untouched, note references it).
 *
 * This module is pure, exact-bigint-paisa math. It only computes & validates the note
 * figures; the tool persists the row and re-checks against the live invoice in one tx.
 *
 * Invariants enforced here (the tool + DB rely on these):
 *   - amounts are positive integer paisa, and taxable + vat == total (reconciles),
 *   - a CREDIT note can never exceed the ORIGINAL invoice's amounts (you cannot refund
 *     more than was billed) — over-credit is REJECTED, never silently capped,
 *   - the note's VAT is consistent with its taxable base at the invoice's rate (within
 *     the 1-paisa rounding the inclusive split allows), so a hand-fed bogus VAT is caught.
 */
import { type Paisa } from '../money/money.js';
import { type TaxConfig } from '../config/tax.js';
import { vatOnExclusive } from '../vat/vat.js';

export type NoteKind = 'credit' | 'debit';

/** The confirmed invoice a note references (the immutable original). */
export interface OriginalInvoice {
  taxablePaisa: Paisa;
  vatPaisa: Paisa;
  totalPaisa: Paisa;
}

/** The requested note figures (VAT-exclusive base + its VAT). */
export interface NoteRequest {
  kind: NoteKind;
  taxablePaisa: Paisa;
  vatPaisa: Paisa;
}

export interface NoteFigures {
  kind: NoteKind;
  taxablePaisa: Paisa;
  vatPaisa: Paisa;
  totalPaisa: Paisa;
}

export class NoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteError';
  }
}

function assertNonNegative(amount: Paisa, label: string): void {
  if (amount < 0n) throw new NoteError(`${label} must not be negative, got ${amount}`);
}

/**
 * Validate a note against its original invoice and return the reconciled figures.
 * Throws NoteError on any violation (nothing is persisted unless this returns).
 */
export function computeNote(req: NoteRequest, original: OriginalInvoice, cfg: TaxConfig): NoteFigures {
  assertNonNegative(req.taxablePaisa, 'note taxable');
  assertNonNegative(req.vatPaisa, 'note VAT');
  const total = req.taxablePaisa + req.vatPaisa;
  if (total <= 0n) throw new NoteError('a note must adjust a positive amount');

  // VAT must be coherent with the taxable base at the configured rate. The inclusive
  // split rounds, so allow a 1-paisa tolerance; anything beyond is a bogus figure.
  const expectedVat = vatOnExclusive(req.taxablePaisa, cfg);
  const diff = req.vatPaisa > expectedVat ? req.vatPaisa - expectedVat : expectedVat - req.vatPaisa;
  if (diff > 1n) {
    throw new NoteError(
      `note VAT ${req.vatPaisa} is inconsistent with taxable ${req.taxablePaisa} at ${cfg.vatRateBps / 100}% ` +
        `(expected ~${expectedVat}) — recompute, do not hand-enter VAT`,
    );
  }

  // A CREDIT note refunds/reduces; it can never exceed the original invoice. A DEBIT
  // note adds to an under-billed invoice and has no upper bound from the original.
  if (req.kind === 'credit') {
    if (req.taxablePaisa > original.taxablePaisa) {
      throw new NoteError(
        `credit note taxable ${req.taxablePaisa} exceeds the original invoice taxable ${original.taxablePaisa} — ` +
          `you cannot credit more than was billed`,
      );
    }
    if (req.vatPaisa > original.vatPaisa) {
      throw new NoteError(
        `credit note VAT ${req.vatPaisa} exceeds the original invoice VAT ${original.vatPaisa}`,
      );
    }
  }

  return { kind: req.kind, taxablePaisa: req.taxablePaisa, vatPaisa: req.vatPaisa, totalPaisa: total };
}
