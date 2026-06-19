/**
 * BS (Bikram Sambat) ↔ AD date helpers, wrapping the pinned `nepali-date-converter`.
 * Out-of-range or invalid dates throw BsDateError — the caller must treat that as
 * BLOCKED ("couldn't verify"), never silently substitute a date (CLAUDE.md §8).
 */
import NepaliDateImport from 'nepali-date-converter';

interface NepaliDateInstance {
  getYear(): number;
  getMonth(): number; // 0-indexed
  getDate(): number;
  toJsDate(): Date;
}
interface NepaliDateClass {
  new (value: Date): NepaliDateInstance;
  new (year: number, monthIndex: number, day: number): NepaliDateInstance;
}
// The package ships a CJS/UMD build with `export default` typings; resolve the
// constructor under both interop shapes (module.exports vs module.exports.default).
const interop = NepaliDateImport as unknown as NepaliDateClass & { default?: NepaliDateClass };
const NepaliDate: NepaliDateClass = interop.default ?? interop;

export interface BsDate {
  year: number;
  /** 1–12 (Baisakh = 1 … Chaitra = 12). */
  month: number;
  day: number;
}

export class BsDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BsDateError';
  }
}

export const BS_MONTH_NAMES = [
  'Baisakh',
  'Jestha',
  'Ashadh',
  'Shrawan',
  'Bhadra',
  'Ashwin',
  'Kartik',
  'Mangsir',
  'Poush',
  'Magh',
  'Falgun',
  'Chaitra',
] as const;

function assertBsFields(bs: BsDate): void {
  if (!Number.isInteger(bs.year) || !Number.isInteger(bs.month) || !Number.isInteger(bs.day)) {
    throw new BsDateError(`BS date fields must be integers: ${JSON.stringify(bs)}`);
  }
  if (bs.month < 1 || bs.month > 12)
    throw new BsDateError(`BS month must be 1–12, got ${bs.month}`);
  if (bs.day < 1 || bs.day > 32) throw new BsDateError(`BS day must be 1–32, got ${bs.day}`);
}

/** Convert an AD (Gregorian) date to BS. */
export function adToBs(ad: Date): BsDate {
  try {
    const nd = new NepaliDate(new Date(ad.getFullYear(), ad.getMonth(), ad.getDate()));
    return { year: nd.getYear(), month: nd.getMonth() + 1, day: nd.getDate() };
  } catch (err) {
    throw new BsDateError(
      `AD date ${ad.toISOString().slice(0, 10)} is outside the supported BS range: ${String(err)}`,
    );
  }
}

/** Convert a BS date to AD. Round-trips internally to reject dates the library silently rolls over. */
export function bsToAd(bs: BsDate): Date {
  assertBsFields(bs);
  let ad: Date;
  try {
    ad = new NepaliDate(bs.year, bs.month - 1, bs.day).toJsDate();
  } catch (err) {
    throw new BsDateError(
      `BS ${bs.year}-${bs.month}-${bs.day} is invalid or out of range: ${String(err)}`,
    );
  }
  const back = adToBs(ad);
  if (back.year !== bs.year || back.month !== bs.month || back.day !== bs.day) {
    throw new BsDateError(
      `BS ${bs.year}-${bs.month}-${bs.day} does not exist (round-trips to ${back.year}-${back.month}-${back.day})`,
    );
  }
  return ad;
}

export interface BsMonthRange {
  from: Date;
  to: Date;
  lastDay: number;
}

/** First and last AD day of a BS month (month lengths vary 29–32 days by year). */
export function bsMonthRange(year: number, month: number): BsMonthRange {
  const from = bsToAd({ year, month, day: 1 });
  for (let day = 32; day >= 28; day--) {
    try {
      const to = bsToAd({ year, month, day });
      return { from, to, lastDay: day };
    } catch {
      // not a real day in this month — try one shorter
    }
  }
  throw new BsDateError(`could not determine length of BS ${year}-${month}`);
}

/**
 * The Nepali fiscal year runs Shrawan (month 4) through Ashadh (month 3 of the next
 * BS year). So a date in months 4–12 belongs to FY = its own year; a date in months
 * 1–3 (Baisakh/Jestha/Ashadh) belongs to FY = year − 1. The FY is named by its
 * starting year (e.g. FY 2082/83 starts Shrawan 2082). IRD requires invoice numbers
 * to be gap-free and reset PER fiscal year (PRD v2.0 §12), so this is the series key.
 */
export function bsFiscalYear(bs: Pick<BsDate, 'year' | 'month'>): number {
  if (!Number.isInteger(bs.year) || !Number.isInteger(bs.month)) {
    throw new BsDateError(`BS year/month must be integers: ${JSON.stringify(bs)}`);
  }
  if (bs.month < 1 || bs.month > 12)
    throw new BsDateError(`BS month must be 1–12, got ${bs.month}`);
  return bs.month >= 4 ? bs.year : bs.year - 1;
}

/** Human label for a fiscal year, e.g. 2082 → "2082/83". */
export function bsFiscalYearLabel(fy: number): string {
  return `${fy}/${String((fy + 1) % 100).padStart(2, '0')}`;
}

export interface FilingDeadline {
  bs: BsDate;
  ad: Date;
}

/**
 * VAT return for BS month M is due the 25th of the FOLLOWING BS month (PRD v1.1 §5.1).
 * This is the statutory rule; the agent still web-fetches the IRD calendar before
 * sending a reminder (rates/deadlines are config + runtime-verified, never assumed).
 */
export function vatFilingDeadline(bsYear: number, bsMonth: number): FilingDeadline {
  assertBsFields({ year: bsYear, month: bsMonth, day: 1 });
  const bs: BsDate =
    bsMonth === 12
      ? { year: bsYear + 1, month: 1, day: 25 }
      : { year: bsYear, month: bsMonth + 1, day: 25 };
  return { bs, ad: bsToAd(bs) };
}

/**
 * TDS withheld in BS month M must be DEPOSITED by the 25th of the FOLLOWING BS month
 * (PRD v1.1 §5.2 / §5.3 — "Deposit by 25th of following month; eTDS mandatory"). This
 * is the SAME statutory cutoff as the VAT return, so we reuse the VAT computation rather
 * than duplicate the rule (one place to change if IRD ever shifts it). Kept as a named,
 * intent-revealing function so the TDS reminder reads as TDS, not VAT. The agent still
 * web-confirms the live IRD calendar before reminding (deadlines are config, never assumed).
 */
export function tdsDepositDeadline(bsYear: number, bsMonth: number): FilingDeadline {
  return vatFilingDeadline(bsYear, bsMonth);
}
