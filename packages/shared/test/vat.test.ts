import { describe, expect, it } from 'vitest';
import { MoneyError } from '../src/money/money.js';
import {
  inputCreditEligibility,
  netVatPosition,
  splitVatInclusive,
  vatOnExclusive,
} from '../src/vat/vat.js';

const ASOF = new Date(2026, 5, 11);

describe('splitVatInclusive', () => {
  it('splits the canonical bill: 9,040 → 8,000 + 1,040', () => {
    expect(splitVatInclusive(904_000n)).toEqual({ exclPaisa: 800_000n, vatPaisa: 104_000n });
  });

  it('rounds half-up on awkward totals', () => {
    // 100 paisa / 1.13 = 88.49… → 88; vat = 12
    expect(splitVatInclusive(100n)).toEqual({ exclPaisa: 88n, vatPaisa: 12n });
  });

  it('INVARIANT: excl + vat === total for every amount', () => {
    for (const total of [0n, 1n, 13n, 99n, 113n, 10_001n, 904_000n, 987_654_321n]) {
      const { exclPaisa, vatPaisa } = splitVatInclusive(total);
      expect(exclPaisa + vatPaisa).toBe(total);
      expect(vatPaisa >= 0n).toBe(true);
    }
  });

  it('rejects negative totals', () => {
    expect(() => splitVatInclusive(-1n)).toThrow(MoneyError);
  });
});

describe('vatOnExclusive', () => {
  it('is 13% half-up', () => {
    expect(vatOnExclusive(800_000n)).toBe(104_000n);
    expect(vatOnExclusive(50n)).toBe(7n); // 6.5 → 7
  });
});

describe('netVatPosition (carry-forward, never negative payment)', () => {
  it('pays the difference when output > input', () => {
    expect(netVatPosition(104_000n, 30_000n)).toEqual({
      netPayablePaisa: 74_000n,
      carryForwardPaisa: 0n,
    });
  });

  it('PROBE: excess input becomes carry-forward, payable stays 0', () => {
    expect(netVatPosition(30_000n, 104_000n)).toEqual({
      netPayablePaisa: 0n,
      carryForwardPaisa: 74_000n,
    });
  });
});

describe('inputCreditEligibility (Sec 18)', () => {
  const good = {
    vendorVatRegistered: true,
    invoiceType: 'rule17' as const,
    invoiceDate: new Date(2026, 4, 20),
    forTaxableBusinessUse: true,
  };

  it('grants credit when all four conditions hold', () => {
    expect(inputCreditEligibility(good, ASOF)).toEqual({ eligible: true, reasons: [] });
  });

  it('exactly 1 year old is still inside the window', () => {
    const d = inputCreditEligibility({ ...good, invoiceDate: new Date(2025, 5, 11) }, ASOF);
    expect(d.eligible).toBe(true);
  });

  it('PROBE: one day past the 1-year window blocks credit', () => {
    const d = inputCreditEligibility({ ...good, invoiceDate: new Date(2025, 5, 10) }, ASOF);
    expect(d.eligible).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/older than 1 year/);
  });

  it('PROBE: Rule 17Ka abbreviated invoice is never claimable', () => {
    const d = inputCreditEligibility({ ...good, invoiceType: 'rule17ka' }, ASOF);
    expect(d.eligible).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/17Ka/);
  });

  it('non-registered vendor, personal use, and future dates each block', () => {
    expect(inputCreditEligibility({ ...good, vendorVatRegistered: false }, ASOF).eligible).toBe(false);
    expect(inputCreditEligibility({ ...good, forTaxableBusinessUse: false }, ASOF).eligible).toBe(false);
    expect(
      inputCreditEligibility({ ...good, invoiceDate: new Date(2027, 0, 1) }, ASOF).eligible,
    ).toBe(false);
  });

  it('UNKNOWN is never treated as eligible (never guess)', () => {
    const d = inputCreditEligibility(
      {
        vendorVatRegistered: undefined,
        invoiceType: undefined,
        invoiceDate: undefined,
        forTaxableBusinessUse: undefined,
      },
      ASOF,
    );
    expect(d.eligible).toBe(false);
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
