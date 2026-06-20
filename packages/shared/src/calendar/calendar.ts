/**
 * Zero-hallucination COMPLIANCE CALENDAR (a core agent capability).
 *
 * WHY THIS EXISTS
 * ---------------
 * A bookkeeping agent must NEVER guess a date. "When is VAT due?", "how many days
 * until the TDS deposit?", "is the 25th a holiday?", "when does the fiscal year end?"
 * are all questions where a wrong answer costs the business a late fee. So dates are
 * computed by THIS deterministic engine and surfaced through governed read-only tools;
 * the model never does calendar arithmetic itself. Same discipline as Money/VAT/TDS:
 * the engine is the single source of truth, and the agent quotes it.
 *
 * The engine is pure (no DB, no clock unless you pass one): you hand it "today" in BS
 * and the open invoices/bills to watch, and it returns the upcoming compliance events
 * with exact AD + BS dates and the days remaining. It reuses the existing statutory
 * helpers (vatFilingDeadline / tdsDepositDeadline / bsFiscalYear / bsMonthRange) so
 * there is ONE place the rules live — no duplicated date math.
 *
 * STATUTORY-DATE INVARIANT (the key zero-hallucination rule)
 * ----------------------------------------------------------
 * A statutory deadline (the 25th) is FIXED by law. If that day happens to be a public
 * holiday, the IRD may or may not extend it — that is THEIR call, not ours. So when a
 * deadline lands on a holiday we DO NOT silently move it: we surface the statutory date
 * AND a `holidayWarning` telling the owner to confirm any extension with the IRD. We
 * never invent a shifted date. (verify_filing_deadline already governs web confirmation.)
 */
import {
  adToBs,
  bsToAd,
  bsFiscalYear,
  bsFiscalYearLabel,
  bsMonthRange,
  tdsDepositDeadline,
  vatFilingDeadline,
  type BsDate,
} from '../bsdate/bsdate.js';

export type CalendarEventKind =
  | 'vat_filing'
  | 'tds_deposit'
  | 'fiscal_year_end'
  | 'fiscal_year_start'
  | 'invoice_due'
  | 'bill_due';

export interface CalendarEvent {
  kind: CalendarEventKind;
  /** Owner-readable label, e.g. "VAT return for Shrawan 2082". */
  title: string;
  /** The authoritative due date in AD (YYYY-MM-DD) and BS. */
  dueAdIso: string;
  dueBs: BsDate;
  /** Whole calendar days from "today" to the due date. Negative = already passed. */
  daysUntil: number;
  /** Set ONLY when the statutory date lands on a configured holiday — confirm with IRD;
   *  never adopt a shifted date on our own. Absent for ordinary events. */
  holidayWarning?: string;
  /** For invoice_due / bill_due: which entity this refers to (echoed back, not invented). */
  refId?: string;
}

/**
 * Holiday config. BS festival closures vary year to year and are NOT hard-coded literals
 * (mirrors "tax rates/deadlines are config"): the caller supplies the holiday set for the
 * year(s) in question (loaded from config / a future holidays table). A holiday is keyed
 * by its BS date. An empty set = "no holidays known" (the engine then emits no holiday
 * warnings — it never fabricates one).
 */
export interface Holiday {
  bs: BsDate;
  name: string;
}

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarError';
  }
}

const BS_MONTH_NAMES = [
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

function bsLabel(bs: Pick<BsDate, 'year' | 'month'>): string {
  return `${BS_MONTH_NAMES[bs.month - 1] ?? `M${bs.month}`} ${bs.year}`;
}

const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const bsKey = (bs: BsDate): string => `${bs.year}-${bs.month}-${bs.day}`;

/** Exact whole-calendar-day difference (to − from), timezone-safe (UTC midnights). */
export function daysUntil(fromAd: Date, toAd: Date): number {
  const a = Date.UTC(fromAd.getFullYear(), fromAd.getMonth(), fromAd.getDate());
  const b = Date.UTC(toAd.getFullYear(), toAd.getMonth(), toAd.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** Is a given BS date a configured business holiday? Returns the holiday name or null. */
export function holidayOn(bs: BsDate, holidays: readonly Holiday[]): string | null {
  const hit = holidays.find((h) => bsKey(h.bs) === bsKey(bs));
  return hit ? hit.name : null;
}

/** The BS month immediately before a BS date (handles year rollover). */
function previousBsMonth(bs: Pick<BsDate, 'year' | 'month'>): { year: number; month: number } {
  return bs.month === 1 ? { year: bs.year - 1, month: 12 } : { year: bs.year, month: bs.month - 1 };
}

/** An open AR invoice / AP bill whose due date should appear on the calendar. */
export interface DueItem {
  refId: string;
  /** 'invoice_due' (AR, customer owes) or 'bill_due' (AP, we owe). */
  kind: 'invoice_due' | 'bill_due';
  /** Due date in AD ISO; the caller passes the stored date — the engine never invents it. */
  dueAdIso: string;
  /** Short label, e.g. the party name. */
  label: string;
}

export interface ComplianceCalendarInput {
  /** "Today" in AD. Defaults to now; pass a fixed date in tests. */
  nowAd?: Date;
  /** Configured holidays for the relevant year(s). Empty = none known. */
  holidays?: readonly Holiday[];
  /** Open invoices/bills to include as due events. Empty = none. */
  dueItems?: readonly DueItem[];
  /** Only return events within this many days ahead (and any already-overdue). Default 45. */
  horizonDays?: number;
}

/**
 * Build the upcoming compliance calendar deterministically from "today". Returns events
 * sorted by due date ascending. Every date is computed by the statutory helpers or echoed
 * from a supplied due item — none is produced by guesswork.
 *
 * The statutory events generated:
 *   - VAT filing for the BS month that just ended (due the 25th of the current BS month),
 *     and the next one (due next month) so the owner sees what's coming,
 *   - TDS deposit on the same cutoffs,
 *   - the current fiscal year's end (Ashadh) and the next fiscal year's start (Shrawan 1),
 *   - each supplied invoice/bill due date.
 * Plus due items the caller passes. A statutory date on a holiday carries a holidayWarning.
 */
export function computeComplianceCalendar(input: ComplianceCalendarInput = {}): CalendarEvent[] {
  const nowAd = input.nowAd ?? new Date();
  const holidays = input.holidays ?? [];
  const dueItems = input.dueItems ?? [];
  const horizon = input.horizonDays ?? 45;
  if (!Number.isInteger(horizon) || horizon < 1) {
    throw new CalendarError(`horizonDays must be a positive integer, got ${horizon}`);
  }

  const todayBs = adToBs(nowAd);
  const events: CalendarEvent[] = [];

  // --- statutory: VAT + TDS for the just-ended month and the current month ---
  // The return/deposit for BS month M is due on the 25th of M+1. So as of "today" in
  // month T, the live obligations are for month T-1 (due this month, the 25th) and month
  // T (due next month). We surface both.
  const monthsToFile = [previousBsMonth(todayBs), { year: todayBs.year, month: todayBs.month }];
  for (const m of monthsToFile) {
    const vat = vatFilingDeadline(m.year, m.month);
    const tds = tdsDepositDeadline(m.year, m.month);
    events.push(
      makeStatutory('vat_filing', `VAT return for ${bsLabel(m)}`, vat.bs, vat.ad, nowAd, holidays),
    );
    events.push(
      makeStatutory(
        'tds_deposit',
        `TDS deposit for ${bsLabel(m)}`,
        tds.bs,
        tds.ad,
        nowAd,
        holidays,
      ),
    );
  }

  // --- statutory: fiscal-year boundaries ---
  const fy = bsFiscalYear(todayBs);
  // FY ends on the last day of Ashadh (month 3) of year (fy+1); starts Shrawan 1 of fy.
  const fyStartBs: BsDate = { year: fy, month: 4, day: 1 };
  const ashadh = bsMonthRange(fy + 1, 3);
  const fyEndBs: BsDate = { year: fy + 1, month: 3, day: ashadh.lastDay };
  events.push(
    makeStatutory(
      'fiscal_year_start',
      `Fiscal year ${bsFiscalYearLabel(fy)} starts`,
      fyStartBs,
      fyStartBs2Ad(fyStartBs),
      nowAd,
      holidays,
    ),
  );
  events.push(
    makeStatutory(
      'fiscal_year_end',
      `Fiscal year ${bsFiscalYearLabel(fy)} ends`,
      fyEndBs,
      ashadh.to,
      nowAd,
      holidays,
    ),
  );

  // --- supplied due items (echoed, never invented) ---
  for (const item of dueItems) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueAdIso)) {
      throw new CalendarError(`due item ${item.refId} has a malformed dueAdIso "${item.dueAdIso}"`);
    }
    const dueAd = parseIso(item.dueAdIso);
    events.push({
      kind: item.kind,
      title: item.kind === 'invoice_due' ? `Invoice due: ${item.label}` : `Bill due: ${item.label}`,
      dueAdIso: item.dueAdIso,
      dueBs: adToBs(dueAd),
      daysUntil: daysUntil(nowAd, dueAd),
      refId: item.refId,
    });
  }

  // Within horizon (keep overdue items so the owner is reminded), sorted by due date.
  return events
    .filter((e) => e.daysUntil <= horizon)
    .sort((a, b) => a.dueAdIso.localeCompare(b.dueAdIso) || a.kind.localeCompare(b.kind));
}

/** Just the next N events from today (most imminent first), within the horizon. */
export function nextDeadlines(
  input: ComplianceCalendarInput & { limit?: number } = {},
): CalendarEvent[] {
  const limit = input.limit ?? 5;
  const upcoming = computeComplianceCalendar(input)
    .filter((e) => e.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil);
  return upcoming.slice(0, limit);
}

// ---------------------------------------------------------------- internals

function makeStatutory(
  kind: CalendarEventKind,
  title: string,
  dueBs: BsDate,
  dueAd: Date,
  nowAd: Date,
  holidays: readonly Holiday[],
): CalendarEvent {
  const holiday = holidayOn(dueBs, holidays);
  const event: CalendarEvent = {
    kind,
    title,
    dueAdIso: isoOf(dueAd),
    dueBs,
    daysUntil: daysUntil(nowAd, dueAd),
  };
  if (holiday) {
    event.holidayWarning =
      `${bsLabel(dueBs)} ${dueBs.day} is a public holiday (${holiday}). The statutory date is unchanged; ` +
      `confirm any IRD extension before relying on a later date — do not assume one.`;
  }
  return event;
}

function parseIso(iso: string): Date {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Shrawan 1 of a BS year → AD. Wraps bsToAd so a bad boundary throws CalendarError. */
function fyStartBs2Ad(bs: BsDate): Date {
  try {
    return bsToAd(bs);
  } catch (err) {
    throw new CalendarError(`could not resolve fiscal-year start ${bsKey(bs)}: ${String(err)}`);
  }
}
