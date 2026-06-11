import { describe, expect, it } from 'vitest';
import { mulBps } from '../src/money/money.js';
import { validateExpense, validateSale } from '../src/validation/engine.js';
import {
  FIXTURE_CLEAN_BILL,
  PROBE_NON_RECONCILING_BILL,
} from '../src/verification/checks.js';

const ASOF = new Date(2026, 5, 11);
const ctx = { asOf: ASOF, existing: [] as const };

describe('validateExpense — happy path', () => {
  it('clean Rule 17 bill passes all checks and earns input credit', () => {
    const report = validateExpense(FIXTURE_CLEAN_BILL, ctx);
    expect(report.overall).toBe('pass');
    expect(report.inputCreditEligible).toBe(true);
    expect(report.results.every((r) => r.result === 'pass')).toBe(true);
  });
});

describe('validateExpense — adversarial probes (each MUST be caught)', () => {
  it('PROBE: non-reconciling totals → warn on vat.totals AND vat.math', () => {
    const report = validateExpense(PROBE_NON_RECONCILING_BILL, ctx);
    expect(report.overall).not.toBe('pass');
    const byCheck = Object.fromEntries(report.results.map((r) => [r.check, r.result]));
    expect(byCheck['vat.totals']).toBe('warn');
    expect(byCheck['vat.math']).toBe('warn');
  });

  it('PROBE: 17Ka bill claimed for credit → ineligible with reason', () => {
    const report = validateExpense({ ...FIXTURE_CLEAN_BILL, invoiceType: 'rule17ka' }, ctx);
    expect(report.inputCreditEligible).toBe(false);
    expect(report.inputCreditReasons.join(' ')).toMatch(/17Ka/);
    expect(report.results.find((r) => r.check === 'vat.input_credit')?.result).toBe('warn');
  });

  it('PROBE: invoice older than 1 year → credit blocked', () => {
    const report = validateExpense(
      { ...FIXTURE_CLEAN_BILL, invoiceDate: new Date(2025, 1, 1) },
      ctx,
    );
    expect(report.inputCreditEligible).toBe(false);
    expect(report.inputCreditReasons.join(' ')).toMatch(/older than/);
  });

  it('PROBE: duplicate by vendor+invoice (case/space-insensitive) → warn', () => {
    const report = validateExpense(FIXTURE_CLEAN_BILL, {
      asOf: ASOF,
      existing: [
        { vendorName: '  SHARMA suppliers ', invoiceNo: 'ss-1042', recordedOn: new Date(2026, 4, 21) },
      ],
    });
    expect(report.results.find((r) => r.check === 'duplicate')?.result).toBe('warn');
  });

  it('PROBE: duplicate by same amount + same date → warn', () => {
    const report = validateExpense(FIXTURE_CLEAN_BILL, {
      asOf: ASOF,
      existing: [{ totalPaisa: 904_000n, occurredOn: new Date(2026, 4, 20) }],
    });
    expect(report.results.find((r) => r.check === 'duplicate')?.result).toBe('warn');
  });

  it('different invoice from the same vendor is NOT a duplicate', () => {
    const report = validateExpense(FIXTURE_CLEAN_BILL, {
      asOf: ASOF,
      existing: [{ vendorName: 'Sharma Suppliers', invoiceNo: 'SS-9999', totalPaisa: 100_000n }],
    });
    expect(report.results.find((r) => r.check === 'duplicate')?.result).toBe('pass');
  });

  it('PROBE: TDS computed on the VAT-inclusive amount → hard fail', () => {
    const report = validateExpense(
      {
        ...FIXTURE_CLEAN_BILL,
        tdsCategory: 'service_contract',
        recipientVatRegistered: true,
        claimedTdsPaisa: mulBps(904_000n, 150), // on total, not taxable — illegal
      },
      ctx,
    );
    expect(report.overall).toBe('fail');
    expect(report.results.find((r) => r.check === 'tds.base')?.reason).toMatch(/INCLUSIVE/);
  });

  it('correct TDS on the exclusive base passes', () => {
    const report = validateExpense(
      {
        ...FIXTURE_CLEAN_BILL,
        tdsCategory: 'service_contract',
        recipientVatRegistered: true,
        claimedTdsPaisa: 12_000n, // 1.5% of 800,000
      },
      ctx,
    );
    expect(report.overall).toBe('pass');
  });

  it('PROBE: claiming TDS where it is exempt/ambiguous → fail (never save a wrong deduction)', () => {
    const report = validateExpense(
      { ...FIXTURE_CLEAN_BILL, tdsCategory: 'salary', claimedTdsPaisa: 1n },
      ctx,
    );
    expect(report.overall).toBe('fail');
  });

  it('PROBE: negative, zero, and absurd amounts → fail, never save', () => {
    expect(validateExpense({ ...FIXTURE_CLEAN_BILL, taxablePaisa: -1n }, ctx).overall).toBe('fail');
    expect(validateExpense({ ...FIXTURE_CLEAN_BILL, totalPaisa: 0n }, ctx).overall).toBe('fail');
    const { vatPaisa: _vat, totalPaisa: _total, ...rest } = FIXTURE_CLEAN_BILL;
    expect(validateExpense({ ...rest, taxablePaisa: 10n ** 15n }, ctx).overall).toBe('fail');
  });
});

describe('validateSale', () => {
  it('clean inclusive sale passes', () => {
    const report = validateSale(
      { description: 'catering', occurredOn: ASOF, taxablePaisa: 800_000n, vatPaisa: 104_000n, totalPaisa: 904_000n },
      ctx,
    );
    expect(report.overall).toBe('pass');
  });

  it('PROBE: same amount on the same day → duplicate warn', () => {
    const report = validateSale(
      { occurredOn: new Date(2026, 5, 10), totalPaisa: 904_000n },
      { asOf: ASOF, existing: [{ totalPaisa: 904_000n, occurredOn: new Date(2026, 5, 10) }] },
    );
    expect(report.results.find((r) => r.check === 'duplicate')?.result).toBe('warn');
  });
});
