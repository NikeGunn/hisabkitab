/**
 * Fiscal-year carry-forward & annual VAT summary (PRD v2.0 §12 "Accounting completeness":
 * "Fiscal year (Shrawan–Ashar): year boundary handling, annual summary, carry-forward of
 * VAT credit across the year").
 *
 * The Nepali VAT period is MONTHLY (file by the 25th of the following BS month). When a
 * month's input VAT exceeds its output VAT, the excess is NOT refunded immediately — it
 * **carries forward** and offsets the next month's output VAT (VAT Act Sec 17/24). This
 * module rolls that carry-forward across a whole BS fiscal year (Shrawan→Ashadh, 12 months)
 * and produces the annual totals + the credit a business carries INTO the next fiscal year.
 *
 * It is pure, exact-bigint-paisa math. It does NOT read the DB: the caller hands it the 12
 * confirmed monthly (outputVat, inputVat) figures (in BS-month order, Shrawan first); this
 * module only does the deterministic roll-up so it is trivially testable and reusable by
 * both the ledger tool and the self-verify recompute.
 *
 * Invariants (the tool + tests rely on these):
 *   - each month's net payable = max(output − (input + broughtForward), 0),
 *   - excess credit (input + broughtForward − output, when positive) carries to next month,
 *   - annual net payable = Σ monthly net payable (carry-forward is intra-year, never lost),
 *   - the final carry-forward is what the business takes INTO the next fiscal year,
 *   - never negative; a month is never both payable AND carrying credit.
 */
import { MoneyError, type Paisa } from '../money/money.js';

/** One BS month's confirmed VAT position, before applying any brought-forward credit. */
export interface MonthlyVat {
  /** BS month 1–12 (Baisakh=1 … Chaitra=12). For a fiscal-year roll-up these are
   *  ordered Shrawan(4)…Chaitra(12) then Baisakh(1)…Ashadh(3) — see annualVatSummary. */
  bsMonth: number;
  outputVatPaisa: Paisa;
  inputVatPaisa: Paisa;
}

export interface MonthlySettlement {
  bsMonth: number;
  outputVatPaisa: Paisa;
  inputVatPaisa: Paisa;
  /** Credit carried INTO this month from prior months (0 for the first). */
  broughtForwardPaisa: Paisa;
  /** What the business actually pays for this month after applying brought-forward credit. */
  netPayablePaisa: Paisa;
  /** Excess credit carried OUT of this month into the next. */
  carryForwardPaisa: Paisa;
}

export interface AnnualVatSummary {
  fiscalYear: number;
  /** Per-month settlement, in the order supplied (Shrawan-first for a FY roll-up). */
  months: MonthlySettlement[];
  totalOutputVatPaisa: Paisa;
  totalInputVatPaisa: Paisa;
  /** Σ of monthly net payable across the year (the cash actually due over the FY). */
  totalNetPayablePaisa: Paisa;
  /** Credit the business carries INTO the next fiscal year (the final month's carry-out). */
  closingCarryForwardPaisa: Paisa;
}

function assertNonNeg(amount: Paisa, label: string): void {
  if (amount < 0n) throw new MoneyError(`${label} cannot be negative: ${amount}`);
}

/**
 * Settle ONE month given the credit brought forward from prior months. Output VAT is offset
 * first by this month's own input VAT and then by any brought-forward credit; whatever output
 * remains is payable, and any unused credit carries forward.
 */
export function settleMonth(month: MonthlyVat, broughtForwardPaisa: Paisa): MonthlySettlement {
  assertNonNeg(month.outputVatPaisa, 'output VAT');
  assertNonNeg(month.inputVatPaisa, 'input VAT');
  assertNonNeg(broughtForwardPaisa, 'brought-forward credit');

  const totalCredit = month.inputVatPaisa + broughtForwardPaisa;
  const diff = month.outputVatPaisa - totalCredit;
  return {
    bsMonth: month.bsMonth,
    outputVatPaisa: month.outputVatPaisa,
    inputVatPaisa: month.inputVatPaisa,
    broughtForwardPaisa,
    netPayablePaisa: diff > 0n ? diff : 0n,
    carryForwardPaisa: diff < 0n ? -diff : 0n,
  };
}

/**
 * Roll the carry-forward across a fiscal year. `months` MUST be in chronological BS order
 * (Shrawan first); `openingCarryForwardPaisa` is the credit brought in from the PRIOR
 * fiscal year (opening balance — default 0 for a business with no prior credit).
 *
 * The roll-up is order-sensitive by design: credit flows forward in time, so the caller
 * is responsible for supplying the months in the right order. A wrong count (not 1..12) or
 * an out-of-range month is rejected — we never silently summarize a partial/garbled year.
 */
export function annualVatSummary(
  fiscalYear: number,
  months: MonthlyVat[],
  openingCarryForwardPaisa: Paisa = 0n,
): AnnualVatSummary {
  if (!Number.isInteger(fiscalYear)) {
    throw new MoneyError(`fiscal year must be an integer: ${fiscalYear}`);
  }
  if (months.length === 0 || months.length > 12) {
    throw new MoneyError(`a fiscal year has 1..12 months, got ${months.length}`);
  }
  assertNonNeg(openingCarryForwardPaisa, 'opening carry-forward');

  const settlements: MonthlySettlement[] = [];
  let carry = openingCarryForwardPaisa;
  let totalOutput = 0n;
  let totalInput = 0n;
  let totalNet = 0n;

  for (const m of months) {
    if (!Number.isInteger(m.bsMonth) || m.bsMonth < 1 || m.bsMonth > 12) {
      throw new MoneyError(`BS month must be 1..12, got ${m.bsMonth}`);
    }
    const s = settleMonth(m, carry);
    settlements.push(s);
    carry = s.carryForwardPaisa;
    totalOutput += m.outputVatPaisa;
    totalInput += m.inputVatPaisa;
    totalNet += s.netPayablePaisa;
  }

  return {
    fiscalYear,
    months: settlements,
    totalOutputVatPaisa: totalOutput,
    totalInputVatPaisa: totalInput,
    totalNetPayablePaisa: totalNet,
    closingCarryForwardPaisa: carry,
  };
}
