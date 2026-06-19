import { describe, expect, it } from 'vitest';
import { computeOpening, OpeningBalanceError } from '../src/accounting/opening.js';

describe('computeOpening (opening balances)', () => {
  it('a receivable opening reconciles to the requested figures', () => {
    const o = computeOpening({ kind: 'receivable', amountPaisa: 904_000n, asOf: '2025-07-16' });
    expect(o).toEqual({ kind: 'receivable', amountPaisa: 904_000n, asOf: '2025-07-16' });
  });

  it('a payable opening is accepted', () => {
    const o = computeOpening({ kind: 'payable', amountPaisa: 1_500_000n, asOf: '2025-07-16' });
    expect(o.kind).toBe('payable');
  });

  it('a vat_credit opening is accepted', () => {
    const o = computeOpening({ kind: 'vat_credit', amountPaisa: 230_000n, asOf: '2025-07-16' });
    expect(o.kind).toBe('vat_credit');
  });

  it('PROBE: a zero opening is REJECTED (meaningless)', () => {
    expect(() =>
      computeOpening({ kind: 'receivable', amountPaisa: 0n, asOf: '2025-07-16' }),
    ).toThrow(/positive amount/);
  });

  it('PROBE: a negative opening is REJECTED', () => {
    expect(() => computeOpening({ kind: 'payable', amountPaisa: -1n, asOf: '2025-07-16' })).toThrow(
      OpeningBalanceError,
    );
  });

  it('PROBE: a non-bigint amount is REJECTED (never coerce a float into paisa)', () => {
    // deliberately wrong type to prove the runtime guard
    const badAmount = 904_000 as unknown as bigint;
    expect(() => computeOpening({ kind: 'receivable', amountPaisa: badAmount, asOf: '2025-07-16' })).toThrow(
      /integer paisa/,
    );
  });

  it('PROBE: a malformed as_of date is REJECTED', () => {
    expect(() =>
      computeOpening({ kind: 'receivable', amountPaisa: 100n, asOf: '16/07/2025' }),
    ).toThrow(/ISO date/);
  });

  it('PROBE: an unknown kind is REJECTED', () => {
    // @ts-expect-error deliberately wrong kind
    expect(() => computeOpening({ kind: 'equity', amountPaisa: 100n, asOf: '2025-07-16' })).toThrow(
      /unknown opening kind/,
    );
  });
});
