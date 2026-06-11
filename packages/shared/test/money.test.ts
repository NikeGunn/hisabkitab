import { describe, expect, it } from 'vitest';
import { divRoundHalfUp, formatNpr, MoneyError, mulBps, nprToPaisa } from '../src/money/money.js';

describe('divRoundHalfUp', () => {
  it('rounds exactly-half up', () => {
    expect(divRoundHalfUp(1n, 2n)).toBe(1n); // 0.5 → 1
    expect(divRoundHalfUp(3n, 2n)).toBe(2n); // 1.5 → 2
    expect(divRoundHalfUp(5n, 4n)).toBe(1n); // 1.25 → 1
    expect(divRoundHalfUp(7n, 4n)).toBe(2n); // 1.75 → 2
  });

  it('is exact for clean divisions', () => {
    expect(divRoundHalfUp(904_000n * 10_000n, 11_300n)).toBe(800_000n);
  });

  it('rounds half toward +infinity for negatives (half-up convention)', () => {
    expect(divRoundHalfUp(-1n, 2n)).toBe(0n); // -0.5 → 0
    expect(divRoundHalfUp(-3n, 2n)).toBe(-1n); // -1.5 → -1
  });

  it('rejects non-positive denominators', () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(MoneyError);
    expect(() => divRoundHalfUp(1n, -3n)).toThrow(MoneyError);
  });
});

describe('mulBps', () => {
  it('computes 13% of Rs 8,000 as Rs 1,040', () => {
    expect(mulBps(800_000n, 1300)).toBe(104_000n);
  });

  it('rounds half-up at the paisa boundary', () => {
    expect(mulBps(50n, 1300)).toBe(7n); // 6.5 paisa → 7
    expect(mulBps(samplePaisa(3), 1)).toBe(0n); // 0.0003 paisa → 0
  });
});

function samplePaisa(n: number): bigint {
  return BigInt(n);
}

describe('nprToPaisa', () => {
  it('parses integers, bigints and 2-decimal strings', () => {
    expect(nprToPaisa(9040)).toBe(904_000n);
    expect(nprToPaisa(9040n)).toBe(904_000n);
    expect(nprToPaisa('9,040.50')).toBe(904_050n);
    expect(nprToPaisa('Rs 9,040')).toBe(904_000n);
    expect(nprToPaisa('0.05')).toBe(5n);
  });

  it('PROBE: refuses floats and 3+ decimals (no silent rounding of money)', () => {
    expect(() => nprToPaisa(90.4)).toThrow(MoneyError);
    expect(() => nprToPaisa('1.005')).toThrow(MoneyError);
    expect(() => nprToPaisa('abc')).toThrow(MoneyError);
    expect(() => nprToPaisa('12.3.4')).toThrow(MoneyError);
    expect(() => nprToPaisa(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
  });
});

describe('formatNpr', () => {
  it('uses Nepali lakh/crore grouping', () => {
    expect(formatNpr(904_000n)).toBe('Rs 9,040.00');
    expect(formatNpr(123_456_789n)).toBe('Rs 12,34,567.89');
    expect(formatNpr(100_000_000n)).toBe('Rs 10,00,000.00'); // 10 lakh
    expect(formatNpr(5n)).toBe('Rs 0.05');
    expect(formatNpr(-904_050n)).toBe('-Rs 9,040.50');
  });
});
