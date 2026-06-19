/**
 * Backdated entries (PRD v2.0 §12 "Accounting completeness": "Backdated entries — allowed
 * with the BS-period correctly assigned + a flag; recompute affected return").
 *
 * An owner sometimes logs a sale/expense days or weeks after it happened (a bill surfaces
 * late). The entry must land in the BS month it OCCURRED in, not the month it was typed —
 * otherwise the wrong VAT return is affected. The ledger already stores `occurred_on` and
 * the return recompute keys off it, so attribution is automatic; what this module adds is:
 *   1. correctly deriving the BS period from the occurrence date,
 *   2. a deterministic "is this backdated?" decision (occurred in an EARLIER BS month than
 *      the entry is being recorded) so the tool can set an `is_backdated` flag + audit it,
 *   3. guarding against an absurd date (in the future) — we never silently accept it.
 *
 * Pure: it takes the occurrence date and "today", returns the assignment + flag. The tool
 * uses the flag to mark the row and to surface "this affects an earlier return — re-run the
 * summary for {period}" to the owner. We never auto-file; we attribute + flag for review.
 */
import { adToBs, bsFiscalYear, type BsDate } from '../bsdate/bsdate.js';

export class BackdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackdateError';
  }
}

export interface BsPeriodAssignment {
  /** The BS date the entry occurred on. */
  occurredBs: BsDate;
  /** BS fiscal year (Shrawan-start) the entry belongs to. */
  fiscalYear: number;
  /** True when the entry occurred in a BS month EARLIER than the recording month. */
  isBackdated: boolean;
}

/** Strip a Date to its local calendar Y/M/D (occurred_on is a calendar date, not an instant). */
function ymd(d: Date): { y: number; m: number; d: number } {
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
}

/**
 * Assign the BS period for an entry occurring on `occurredOn`, recorded on `recordedOn`
 * (default: now). Throws if the entry is dated in the FUTURE relative to the recording day
 * (a future-dated financial entry is never valid — treat as BLOCKED, ask the owner).
 *
 * `isBackdated` is true when the occurrence falls in an earlier BS month than the recording
 * month — i.e. it affects a return period the owner may have already prepared, so the tool
 * flags it and tells the owner which period to re-summarize.
 */
export function assignBsPeriod(
  occurredOn: Date,
  recordedOn: Date = new Date(),
): BsPeriodAssignment {
  const occ = ymd(occurredOn);
  const rec = ymd(recordedOn);

  // Compare calendar days in AD (occurred must not be after the recording day).
  const occUtc = Date.UTC(occ.y, occ.m, occ.d);
  const recUtc = Date.UTC(rec.y, rec.m, rec.d);
  if (occUtc > recUtc) {
    throw new BackdateError(
      `entry date ${occ.y}-${String(occ.m + 1).padStart(2, '0')}-${String(occ.d).padStart(2, '0')} is in the future — a financial entry cannot be dated ahead of today`,
    );
  }

  const occurredBs = adToBs(occurredOn);
  const recordedBs = adToBs(recordedOn);
  const fiscalYear = bsFiscalYear(occurredBs);

  // Backdated = occurred in an earlier BS (year, month) than the recording month.
  const isBackdated =
    occurredBs.year < recordedBs.year ||
    (occurredBs.year === recordedBs.year && occurredBs.month < recordedBs.month);

  return { occurredBs, fiscalYear, isBackdated };
}
