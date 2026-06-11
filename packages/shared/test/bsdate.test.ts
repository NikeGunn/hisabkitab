import { describe, expect, it } from 'vitest';
import {
  adToBs,
  BS_MONTH_NAMES,
  BsDateError,
  bsMonthRange,
  bsToAd,
  vatFilingDeadline,
} from '../src/bsdate/bsdate.js';

describe('adToBs / bsToAd', () => {
  it('anchors: 14 Apr 2025 = 1 Baisakh 2082 (Nepali New Year)', () => {
    expect(adToBs(new Date(2025, 3, 14))).toEqual({ year: 2082, month: 1, day: 1 });
  });

  it('round-trips across every month of 2082', () => {
    for (let month = 1; month <= 12; month++) {
      const ad = bsToAd({ year: 2082, month, day: 15 });
      expect(adToBs(ad)).toEqual({ year: 2082, month, day: 15 });
    }
  });

  it('month boundaries: last day of a month is followed by the 1st of the next', () => {
    const { to, lastDay } = bsMonthRange(2082, 4); // Shrawan
    expect(lastDay).toBeGreaterThanOrEqual(29);
    expect(lastDay).toBeLessThanOrEqual(32);
    const nextDay = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
    expect(adToBs(nextDay)).toEqual({ year: 2082, month: 5, day: 1 });
  });

  it('PROBE: impossible BS dates throw instead of rolling over', () => {
    expect(() => bsToAd({ year: 2082, month: 13, day: 1 })).toThrow(BsDateError);
    expect(() => bsToAd({ year: 2082, month: 0, day: 1 })).toThrow(BsDateError);
    expect(() => bsToAd({ year: 2082, month: 11, day: 32 })).toThrow(BsDateError);
    expect(() => bsToAd({ year: 2082, month: 1, day: 1.5 })).toThrow(BsDateError);
  });

  it('PROBE: out-of-range years raise BsDateError (BLOCKED, not a guessed date)', () => {
    expect(() => bsToAd({ year: 2300, month: 1, day: 1 })).toThrow(BsDateError);
    expect(() => adToBs(new Date(2300, 0, 1))).toThrow(BsDateError);
  });
});

describe('vatFilingDeadline (25th of the following BS month)', () => {
  it('Shrawan return is due 25 Bhadra', () => {
    const dl = vatFilingDeadline(2082, 4);
    expect(dl.bs).toEqual({ year: 2082, month: 5, day: 25 });
    expect(adToBs(dl.ad)).toEqual(dl.bs);
  });

  it('PROBE: Chaitra (month 12) rolls into Baisakh of the NEXT year', () => {
    const dl = vatFilingDeadline(2082, 12);
    expect(dl.bs).toEqual({ year: 2083, month: 1, day: 25 });
  });
});

describe('month names', () => {
  it('Baisakh..Chaitra in order', () => {
    expect(BS_MONTH_NAMES).toHaveLength(12);
    expect(BS_MONTH_NAMES[0]).toBe('Baisakh');
    expect(BS_MONTH_NAMES[3]).toBe('Shrawan');
    expect(BS_MONTH_NAMES[11]).toBe('Chaitra');
  });
});
