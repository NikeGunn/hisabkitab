/**
 * Nepal VAT pure functions (PRD v1.1 §5.1, FY 2082/83).
 * Inclusive split invariant: exclPaisa + vatPaisa === totalPaisa, always and exactly.
 */
import { divRoundHalfUp, MoneyError, mulBps, type Paisa } from '../money/money.js';
import { defaultTaxConfig, type TaxConfig } from '../config/tax.js';

export interface VatSplit {
  exclPaisa: Paisa;
  vatPaisa: Paisa;
}

/** VAT-inclusive amount X → excl = round(X / 1.13), vat = X − excl (integer paisa, half-up). */
export function splitVatInclusive(totalPaisa: Paisa, cfg: TaxConfig = defaultTaxConfig): VatSplit {
  if (totalPaisa < 0n) throw new MoneyError(`VAT-inclusive amount cannot be negative: ${totalPaisa}`);
  const exclPaisa = divRoundHalfUp(totalPaisa * 10_000n, 10_000n + BigInt(cfg.vatRateBps));
  return { exclPaisa, vatPaisa: totalPaisa - exclPaisa };
}

/** Output VAT on an exclusive (net) amount: round(excl × 13%). */
export function vatOnExclusive(exclPaisa: Paisa, cfg: TaxConfig = defaultTaxConfig): Paisa {
  if (exclPaisa < 0n) throw new MoneyError(`exclusive amount cannot be negative: ${exclPaisa}`);
  return mulBps(exclPaisa, cfg.vatRateBps);
}

/** The taxable value and VAT exactly as PRINTED on a tax invoice (integer paisa). */
export interface PrintedVat {
  taxablePaisa: Paisa;
  vatPaisa: Paisa;
}

export interface InvoiceVatInput {
  /** The amount the owner gave: the invoice total if `inclusive`, else its taxable value. */
  amountPaisa: Paisa;
  inclusive: boolean;
  /** false for a non-VAT-registered vendor: no VAT is charged at all. */
  vatApplies: boolean;
  /** The invoice's own printed figures, when it shows them. Authoritative when present. */
  printed?: PrintedVat | undefined;
}

export type InvoiceVat =
  | {
      ok: true;
      exclPaisa: Paisa;
      vatPaisa: Paisa;
      /** 'printed' = the invoice's figures were stored; 'computed' = derived at 13%. */
      source: 'printed' | 'computed';
      /** What 13% invoice-level half-up would give, for transparency. */
      computedVatPaisa: Paisa;
    }
  | { ok: false; reason: string };

/**
 * Resolve the taxable value + VAT to STORE for an invoice.
 *
 * A tax invoice is the legal evidence of the VAT charged, so when its printed taxable
 * and VAT figures are supplied they are stored EXACTLY. Re-deriving VAT from the total
 * would silently diverge from the invoice whenever the issuer rounded per line (it does
 * for 19–73% of multi-line bills, by 1–6 paisa). Printed figures are never "corrected":
 * they must reconcile with the amount the owner gave, or nothing is resolved and the
 * caller must ask. Whether the printed VAT is 13% of taxable stays the Validation
 * Engine's job (vat.math → WARN shown to the owner), not something fixed here.
 *
 * Invariant (every ok result): exclPaisa + vatPaisa === the invoice total.
 */
export function resolveInvoiceVat(input: InvoiceVatInput, cfg: TaxConfig = defaultTaxConfig): InvoiceVat {
  const { amountPaisa, inclusive, vatApplies, printed } = input;
  if (amountPaisa <= 0n) return { ok: false, reason: 'amount must be a positive number of paisa' };
  const computed = !vatApplies
    ? { exclPaisa: amountPaisa, vatPaisa: 0n }
    : inclusive
      ? splitVatInclusive(amountPaisa, cfg)
      : { exclPaisa: amountPaisa, vatPaisa: vatOnExclusive(amountPaisa, cfg) };
  if (printed === undefined) {
    return { ok: true, ...computed, source: 'computed', computedVatPaisa: computed.vatPaisa };
  }

  const { taxablePaisa, vatPaisa } = printed;
  if (taxablePaisa < 0n || vatPaisa < 0n) {
    return { ok: false, reason: 'the printed taxable amount and VAT cannot be negative' };
  }
  if (!vatApplies && vatPaisa > 0n) {
    return {
      ok: false,
      reason: 'the bill shows VAT but the vendor is marked NOT VAT-registered — please confirm which is right',
    };
  }
  if (inclusive && taxablePaisa + vatPaisa !== amountPaisa) {
    return {
      ok: false,
      reason: `the bill's taxable amount + VAT (${taxablePaisa + vatPaisa} paisa) does not equal its total (${amountPaisa} paisa) — please confirm the figures`,
    };
  }
  if (!inclusive && taxablePaisa !== amountPaisa) {
    return {
      ok: false,
      reason: `the bill's printed taxable amount (${taxablePaisa} paisa) does not match the amount given (${amountPaisa} paisa) — please confirm the figures`,
    };
  }
  return { ok: true, exclPaisa: taxablePaisa, vatPaisa, source: 'printed', computedVatPaisa: computed.vatPaisa };
}

export interface VatPosition {
  netPayablePaisa: Paisa;
  /** If input > output, the excess carries forward as credit — never pay/refund negative. */
  carryForwardPaisa: Paisa;
}

/** Net payable = max(output − input, 0); excess input carries forward (Sec 17/24). */
export function netVatPosition(outputVatPaisa: Paisa, inputVatPaisa: Paisa): VatPosition {
  if (outputVatPaisa < 0n || inputVatPaisa < 0n) {
    throw new MoneyError('VAT totals cannot be negative');
  }
  const diff = outputVatPaisa - inputVatPaisa;
  return {
    netPayablePaisa: diff > 0n ? diff : 0n,
    carryForwardPaisa: diff < 0n ? -diff : 0n,
  };
}

export type InvoiceType = 'rule17' | 'rule17ka' | 'other';

export interface InputCreditInput {
  vendorVatRegistered: boolean | undefined;
  invoiceType: InvoiceType | undefined;
  invoiceDate: Date | undefined;
  /** Purchase is for taxable business use (not exempt/Schedule-1 or personal). */
  forTaxableBusinessUse: boolean | undefined;
}

export interface InputCreditDecision {
  eligible: boolean;
  /** Every failing condition, in owner-readable language. Empty when eligible. */
  reasons: string[];
}

function addYears(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  out.setFullYear(out.getFullYear() + years);
  return out;
}

/**
 * Input Tax Credit (Sec 18): claimable only if ALL hold — vendor VAT-registered,
 * full Rule 17 invoice (NOT 17Ka abbreviated), invoice within the 1-year window,
 * and purchase for taxable business use. Unknown ≠ eligible: missing facts block credit.
 */
export function inputCreditEligibility(
  input: InputCreditInput,
  asOf: Date,
  cfg: TaxConfig = defaultTaxConfig,
): InputCreditDecision {
  const reasons: string[] = [];

  if (input.vendorVatRegistered !== true) {
    reasons.push(
      input.vendorVatRegistered === false
        ? 'vendor is not VAT-registered'
        : 'vendor VAT registration status is unknown — please confirm',
    );
  }
  if (input.invoiceType === 'rule17ka') {
    reasons.push('this is an abbreviated (Rule 17Ka) invoice — not valid for input credit');
  } else if (input.invoiceType !== 'rule17') {
    reasons.push('invoice type is not a confirmed full Rule 17 tax invoice');
  }
  if (input.invoiceDate === undefined) {
    reasons.push('invoice date is unknown — cannot confirm the 1-year credit window');
  } else if (input.invoiceDate.getTime() > asOf.getTime()) {
    reasons.push('invoice date is in the future — please check the date');
  } else if (addYears(input.invoiceDate, cfg.inputCreditWindowYears).getTime() < asOf.getTime()) {
    reasons.push(`invoice is older than ${cfg.inputCreditWindowYears} year(s) — credit window has closed`);
  }
  if (input.forTaxableBusinessUse !== true) {
    reasons.push(
      input.forTaxableBusinessUse === false
        ? 'purchase is not for taxable business use'
        : 'business-use status is unknown — please confirm',
    );
  }

  return { eligible: reasons.length === 0, reasons };
}
