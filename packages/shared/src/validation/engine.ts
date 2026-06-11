/**
 * Layer 2 — Validation Engine (PRD v1.1 §4.2).
 * Pure functions called by the Ledger MCP before any save and by the agent before
 * asserting figures. Each check returns pass | warn | fail with an owner-readable reason.
 *   fail → never save; ask.   warn → surface in the confirmation message.   pass → proceed.
 */
import { mulBps, type Paisa } from '../money/money.js';
import { defaultTaxConfig, type TaxConfig } from '../config/tax.js';
import { inputCreditEligibility, type InvoiceType } from '../vat/vat.js';
import { computeTds, type TdsCategory } from '../tds/tds.js';

export type CheckOutcome = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  check: string;
  result: CheckOutcome;
  reason: string;
}

export interface ValidationReport {
  overall: CheckOutcome;
  results: CheckResult[];
  inputCreditEligible: boolean;
  inputCreditReasons: string[];
}

export interface ExpenseCandidate {
  vendorName?: string;
  vendorVatRegistered?: boolean;
  invoiceNo?: string;
  invoiceDate?: Date;
  invoiceType?: InvoiceType;
  taxablePaisa?: Paisa;
  vatPaisa?: Paisa;
  totalPaisa?: Paisa;
  forTaxableBusinessUse?: boolean;
  /** When the agent proposes a TDS figure, the engine recomputes and must agree. */
  tdsCategory?: TdsCategory;
  recipientVatRegistered?: boolean;
  claimedTdsPaisa?: Paisa;
}

export interface SaleCandidate {
  description?: string;
  occurredOn?: Date;
  taxablePaisa?: Paisa;
  vatPaisa?: Paisa;
  totalPaisa?: Paisa;
}

/** Minimal view of already-recorded entries, for duplicate detection. */
export interface ExistingEntryRef {
  id?: string;
  vendorName?: string;
  invoiceNo?: string;
  totalPaisa?: Paisa;
  occurredOn?: Date;
  recordedOn?: Date;
}

export interface ValidationContext {
  asOf: Date;
  existing?: readonly ExistingEntryRef[];
  cfg?: TaxConfig;
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const sameDay = (a: Date | undefined, b: Date | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function worst(results: readonly CheckResult[]): CheckOutcome {
  if (results.some((r) => r.result === 'fail')) return 'fail';
  if (results.some((r) => r.result === 'warn')) return 'warn';
  return 'pass';
}

function checkAmountSanity(
  amounts: ReadonlyArray<readonly [name: string, value: Paisa | undefined]>,
  cfg: TaxConfig,
): CheckResult {
  for (const [name, value] of amounts) {
    if (value === undefined) continue;
    if (name !== 'VAT' && value <= 0n) {
      return { check: 'sanity.amounts', result: 'fail', reason: `${name} is not a positive amount` };
    }
    if (value < 0n) {
      return { check: 'sanity.amounts', result: 'fail', reason: `${name} is negative` };
    }
    if (value > cfg.maxAmountPaisa) {
      return {
        check: 'sanity.amounts',
        result: 'fail',
        reason: `${name} looks absurdly large — please confirm the figure`,
      };
    }
  }
  return { check: 'sanity.amounts', result: 'pass', reason: 'amounts are within sane bounds' };
}

function checkVatMath(taxable: Paisa | undefined, vat: Paisa | undefined, cfg: TaxConfig): CheckResult {
  if (taxable === undefined || vat === undefined) {
    return { check: 'vat.math', result: 'pass', reason: 'VAT math not checkable (field missing)' };
  }
  const expected = mulBps(taxable, cfg.vatRateBps);
  const diff = vat > expected ? vat - expected : expected - vat;
  return diff <= cfg.vatTolerancePaisa
    ? { check: 'vat.math', result: 'pass', reason: 'VAT is 13% of the taxable amount' }
    : {
        check: 'vat.math',
        result: 'warn',
        reason: `the VAT on this bill isn't exactly 13% of the taxable amount — please confirm the figures`,
      };
}

function checkTotals(
  taxable: Paisa | undefined,
  vat: Paisa | undefined,
  total: Paisa | undefined,
): CheckResult {
  if (taxable === undefined || vat === undefined || total === undefined) {
    return { check: 'vat.totals', result: 'pass', reason: 'totals not checkable (field missing)' };
  }
  return taxable + vat === total
    ? { check: 'vat.totals', result: 'pass', reason: 'taxable + VAT equals the total' }
    : {
        check: 'vat.totals',
        result: 'warn',
        reason: `taxable + VAT does not add up to the total — please confirm the figures`,
      };
}

function checkDuplicate(
  candidate: { vendorName?: string; invoiceNo?: string; totalPaisa?: Paisa; occurredOn?: Date },
  existing: readonly ExistingEntryRef[],
): CheckResult {
  for (const prev of existing) {
    const vendorMatch =
      norm(candidate.vendorName) !== '' && norm(candidate.vendorName) === norm(prev.vendorName);
    const invoiceMatch =
      norm(candidate.invoiceNo) !== '' && norm(candidate.invoiceNo) === norm(prev.invoiceNo);
    const amountDateMatch =
      candidate.totalPaisa !== undefined &&
      candidate.totalPaisa === prev.totalPaisa &&
      sameDay(candidate.occurredOn, prev.occurredOn);

    if ((vendorMatch && invoiceMatch) || amountDateMatch) {
      const when = prev.recordedOn?.toISOString().slice(0, 10) ?? 'earlier';
      return {
        check: 'duplicate',
        result: 'warn',
        reason: `looks like I may have already saved this bill on ${when} — is it a duplicate?`,
      };
    }
  }
  return { check: 'duplicate', result: 'pass', reason: 'no matching earlier entry found' };
}

function checkTds(candidate: ExpenseCandidate, cfg: TaxConfig): CheckResult {
  if (candidate.claimedTdsPaisa === undefined || candidate.tdsCategory === undefined) {
    return { check: 'tds.base', result: 'pass', reason: 'no TDS figure claimed' };
  }
  if (candidate.taxablePaisa === undefined) {
    return {
      check: 'tds.base',
      result: 'fail',
      reason: 'a TDS amount was claimed but the VAT-exclusive base is unknown — cannot verify',
    };
  }
  const decision = computeTds(
    {
      category: candidate.tdsCategory,
      baseExclVatPaisa: candidate.taxablePaisa,
      ...(candidate.recipientVatRegistered !== undefined
        ? { recipientVatRegistered: candidate.recipientVatRegistered }
        : {}),
    },
    cfg,
  );
  if (decision.kind !== 'computed') {
    return {
      check: 'tds.base',
      result: 'fail',
      reason: `a TDS amount was claimed but TDS is ${decision.kind.replace('_', ' ')} here: ${decision.reason}`,
    };
  }
  if (candidate.claimedTdsPaisa === decision.tdsPaisa) {
    return { check: 'tds.base', result: 'pass', reason: 'TDS matches the rate on the VAT-exclusive base' };
  }
  const onInclusive =
    candidate.totalPaisa !== undefined && candidate.claimedTdsPaisa === mulBps(candidate.totalPaisa, decision.rateBps);
  return {
    check: 'tds.base',
    result: 'fail',
    reason: onInclusive
      ? 'TDS appears to be computed on the VAT-INCLUSIVE amount — TDS base must exclude VAT'
      : `claimed TDS ${candidate.claimedTdsPaisa} ≠ expected ${decision.tdsPaisa} (${decision.rateBps / 100}% of the VAT-exclusive base)`,
  };
}

export function validateExpense(candidate: ExpenseCandidate, ctx: ValidationContext): ValidationReport {
  const cfg = ctx.cfg ?? defaultTaxConfig;
  const existing = ctx.existing ?? [];

  const credit = inputCreditEligibility(
    {
      vendorVatRegistered: candidate.vendorVatRegistered,
      invoiceType: candidate.invoiceType,
      invoiceDate: candidate.invoiceDate,
      forTaxableBusinessUse: candidate.forTaxableBusinessUse,
    },
    ctx.asOf,
    cfg,
  );

  const results: CheckResult[] = [
    checkAmountSanity(
      [
        ['taxable amount', candidate.taxablePaisa],
        ['VAT', candidate.vatPaisa],
        ['total', candidate.totalPaisa],
      ],
      cfg,
    ),
    checkVatMath(candidate.taxablePaisa, candidate.vatPaisa, cfg),
    checkTotals(candidate.taxablePaisa, candidate.vatPaisa, candidate.totalPaisa),
    credit.eligible
      ? { check: 'vat.input_credit', result: 'pass', reason: 'input VAT credit is claimable' }
      : {
          check: 'vat.input_credit',
          result: 'warn',
          reason: `input VAT credit cannot be claimed: ${credit.reasons.join('; ')}`,
        },
    checkDuplicate(
      {
        ...(candidate.vendorName !== undefined ? { vendorName: candidate.vendorName } : {}),
        ...(candidate.invoiceNo !== undefined ? { invoiceNo: candidate.invoiceNo } : {}),
        ...(candidate.totalPaisa !== undefined ? { totalPaisa: candidate.totalPaisa } : {}),
        ...(candidate.invoiceDate !== undefined ? { occurredOn: candidate.invoiceDate } : {}),
      },
      existing,
    ),
    checkTds(candidate, cfg),
  ];

  return {
    overall: worst(results),
    results,
    inputCreditEligible: credit.eligible,
    inputCreditReasons: credit.reasons,
  };
}

export function validateSale(candidate: SaleCandidate, ctx: ValidationContext): ValidationReport {
  const cfg = ctx.cfg ?? defaultTaxConfig;
  const existing = ctx.existing ?? [];

  const results: CheckResult[] = [
    checkAmountSanity(
      [
        ['taxable amount', candidate.taxablePaisa],
        ['VAT', candidate.vatPaisa],
        ['total', candidate.totalPaisa],
      ],
      cfg,
    ),
    checkVatMath(candidate.taxablePaisa, candidate.vatPaisa, cfg),
    checkTotals(candidate.taxablePaisa, candidate.vatPaisa, candidate.totalPaisa),
    checkDuplicate(
      {
        ...(candidate.totalPaisa !== undefined ? { totalPaisa: candidate.totalPaisa } : {}),
        ...(candidate.occurredOn !== undefined ? { occurredOn: candidate.occurredOn } : {}),
      },
      existing,
    ),
  ];

  return { overall: worst(results), results, inputCreditEligible: false, inputCreditReasons: [] };
}
