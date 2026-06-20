import { describe, expect, it } from 'vitest';
import {
  CalendarError,
  computeComplianceCalendar,
  daysUntil,
  holidayOn,
  nextDeadlines,
  type DueItem,
  type Holiday,
} from '../src/calendar/calendar.js';
import { adToBs, vatFilingDeadline } from '../src/bsdate/bsdate.js';

// A fixed "today" so the calendar is deterministic. 2025-08-10 is comfortably inside
// a BS month (≈ Shrawan 2082), away from any month boundary.
const NOW = new Date(2025, 7, 10); // 10 Aug 2025 (local)

describe('daysUntil (exact, timezone-safe)', () => {
  it('counts whole calendar days regardless of time-of-day', () => {
    expect(daysUntil(new Date(2025, 7, 10, 23, 0), new Date(2025, 7, 12, 1, 0))).toBe(2);
  });
  it('is negative for a past date', () => {
    expect(daysUntil(new Date(2025, 7, 10), new Date(2025, 7, 7))).toBe(-3);
  });
});

describe('computeComplianceCalendar — statutory events', () => {
  const cal = computeComplianceCalendar({ nowAd: NOW });

  it('always includes VAT filing and TDS deposit events', () => {
    expect(cal.some((e) => e.kind === 'vat_filing')).toBe(true);
    expect(cal.some((e) => e.kind === 'tds_deposit')).toBe(true);
  });

  it('VAT and TDS for the same month share the SAME due date (one statutory rule)', () => {
    const vat = cal.filter((e) => e.kind === 'vat_filing');
    const tds = cal.filter((e) => e.kind === 'tds_deposit');
    // pair them by title month; the earliest of each must coincide
    expect(vat[0]!.dueAdIso).toBe(tds[0]!.dueAdIso);
  });

  it('every event carries an exact AD date that round-trips to its stated BS date', () => {
    for (const e of cal) {
      const back = adToBs(new Date(`${e.dueAdIso}T00:00:00`));
      expect(back).toEqual(e.dueBs);
    }
  });

  it('a VAT deadline matches the statutory helper exactly (no independent guess)', () => {
    const e = cal.find((e) => e.kind === 'vat_filing')!;
    // recompute the deadline from its BS due date's month-before via the helper
    const filedMonth =
      e.dueBs.month === 1
        ? { y: e.dueBs.year - 1, m: 12 }
        : { y: e.dueBs.year, m: e.dueBs.month - 1 };
    const expected = vatFilingDeadline(filedMonth.y, filedMonth.m);
    expect(e.dueBs).toEqual(expected.bs);
  });

  it('with a wide horizon, surfaces both fiscal-year start and end', () => {
    // The FY boundaries can fall outside the default 45-day window depending on the
    // month, so assert them against a wide horizon where they must appear.
    const wide = computeComplianceCalendar({ nowAd: NOW, horizonDays: 400 });
    expect(wide.some((e) => e.kind === 'fiscal_year_end')).toBe(true);
    expect(wide.some((e) => e.kind === 'fiscal_year_start')).toBe(true);
  });
});

describe('PROBE: zero-hallucination invariants', () => {
  it('a statutory date on a holiday is NOT moved — it carries a warning instead', () => {
    // Find the VAT deadline's BS date, then mark THAT day a holiday.
    const base = computeComplianceCalendar({ nowAd: NOW });
    const vat = base.find((e) => e.kind === 'vat_filing')!;
    const holidays: Holiday[] = [{ bs: vat.dueBs, name: 'Test Festival' }];

    const withHoliday = computeComplianceCalendar({ nowAd: NOW, holidays });
    const vat2 = withHoliday.find((e) => e.kind === 'vat_filing' && e.dueAdIso === vat.dueAdIso)!;
    // the date is UNCHANGED…
    expect(vat2.dueAdIso).toBe(vat.dueAdIso);
    // …and a warning tells the owner to confirm with the IRD, never assuming a shift
    expect(vat2.holidayWarning).toMatch(/holiday|confirm|do not assume/i);
  });

  it('no holiday config ⇒ no fabricated holiday warnings', () => {
    const cal = computeComplianceCalendar({ nowAd: NOW, holidays: [] });
    expect(cal.every((e) => e.holidayWarning === undefined)).toBe(true);
  });

  it('a malformed due-item date is REJECTED, never silently parsed', () => {
    const bad: DueItem = { refId: 'x', kind: 'invoice_due', dueAdIso: '10/08/2025', label: 'X' };
    expect(() => computeComplianceCalendar({ nowAd: NOW, dueItems: [bad] })).toThrow(CalendarError);
  });

  it('a non-positive horizon is REJECTED', () => {
    expect(() => computeComplianceCalendar({ nowAd: NOW, horizonDays: 0 })).toThrow(CalendarError);
  });
});

describe('due items + nextDeadlines', () => {
  it('echoes a supplied invoice due date (never invents one) with correct daysUntil', () => {
    const due: DueItem = {
      refId: 'inv-1',
      kind: 'invoice_due',
      dueAdIso: '2025-08-20',
      label: 'Sharma Traders',
    };
    const cal = computeComplianceCalendar({ nowAd: NOW, dueItems: [due] });
    const e = cal.find((x) => x.refId === 'inv-1')!;
    expect(e.dueAdIso).toBe('2025-08-20');
    expect(e.daysUntil).toBe(10); // 10 → 20 Aug
    expect(e.kind).toBe('invoice_due');
  });

  it('nextDeadlines returns only upcoming events, most imminent first, capped to the limit', () => {
    const next = nextDeadlines({ nowAd: NOW, limit: 3 });
    expect(next.length).toBeLessThanOrEqual(3);
    for (const e of next) expect(e.daysUntil).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < next.length; i++) {
      expect(next[i]!.daysUntil).toBeGreaterThanOrEqual(next[i - 1]!.daysUntil);
    }
  });

  it('PROBE: an overdue item is kept (so the owner is reminded), with negative daysUntil', () => {
    const overdue: DueItem = {
      refId: 'inv-old',
      kind: 'invoice_due',
      dueAdIso: '2025-08-01',
      label: 'Late Co',
    };
    const cal = computeComplianceCalendar({ nowAd: NOW, dueItems: [overdue] });
    const e = cal.find((x) => x.refId === 'inv-old')!;
    expect(e.daysUntil).toBeLessThan(0);
    // but nextDeadlines (upcoming only) excludes it
    expect(
      nextDeadlines({ nowAd: NOW, dueItems: [overdue] }).some((x) => x.refId === 'inv-old'),
    ).toBe(false);
  });
});

describe('holidayOn', () => {
  it('matches by BS date and returns the name, else null', () => {
    const holidays: Holiday[] = [{ bs: { year: 2082, month: 6, day: 12 }, name: 'Dashain' }];
    expect(holidayOn({ year: 2082, month: 6, day: 12 }, holidays)).toBe('Dashain');
    expect(holidayOn({ year: 2082, month: 6, day: 13 }, holidays)).toBeNull();
  });
});
