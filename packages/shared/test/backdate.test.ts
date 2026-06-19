import { describe, expect, it } from 'vitest';
import { assignBsPeriod, BackdateError } from '../src/accounting/backdate.js';
import { adToBs, bsFiscalYear } from '../src/bsdate/bsdate.js';

describe('assignBsPeriod (backdated entries)', () => {
  it('an entry recorded the same day it occurred is NOT backdated', () => {
    const day = new Date(2025, 8, 10); // 10 Sep 2025 (local)
    const a = assignBsPeriod(day, day);
    expect(a.isBackdated).toBe(false);
    expect(a.fiscalYear).toBe(bsFiscalYear(adToBs(day)));
  });

  it('an entry occurring a month before it is recorded IS backdated', () => {
    const occurred = new Date(2025, 6, 20); // 20 Jul 2025
    const recorded = new Date(2025, 8, 10); // 10 Sep 2025
    const a = assignBsPeriod(occurred, recorded);
    expect(a.isBackdated).toBe(true);
    expect(a.occurredBs).toEqual(adToBs(occurred));
  });

  it('attributes a backdated entry to the BS fiscal year it OCCURRED in, not when recorded', () => {
    const occurred = new Date(2025, 6, 1); // early Jul 2025 → BS Ashadh 2082 → FY 2081
    const recorded = new Date(2025, 9, 1); // Oct 2025 → BS Kartik 2082 → FY 2082
    const a = assignBsPeriod(occurred, recorded);
    expect(a.fiscalYear).toBe(bsFiscalYear(adToBs(occurred)));
  });

  it('PROBE: a future-dated entry is REJECTED (never silently accepted)', () => {
    const occurred = new Date(2025, 8, 11); // 11 Sep
    const recorded = new Date(2025, 8, 10); // 10 Sep — occurred is after
    expect(() => assignBsPeriod(occurred, recorded)).toThrow(BackdateError);
  });

  it('same calendar day across a timezone-sensitive boundary is not "future" (calendar compare, not instant)', () => {
    const occurred = new Date(2025, 8, 10, 23, 59); // late on the 10th
    const recorded = new Date(2025, 8, 10, 0, 1); // early on the 10th
    expect(() => assignBsPeriod(occurred, recorded)).not.toThrow();
    expect(assignBsPeriod(occurred, recorded).isBackdated).toBe(false);
  });
});
