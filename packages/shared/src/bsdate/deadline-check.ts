/**
 * Governed IRD-deadline web-verification (PRD v1.1 §5; CLAUDE.md §3 "verify current
 * IRD deadline via web fetch"). PURE, no IO.
 *
 * The product promise is zero fabrication: a number pulled off a web page may
 * CONFIRM the deterministic computation, but may NEVER silently replace it. So this
 * function takes the authoritative computed deadline (from `vatFilingDeadline`) plus
 * whatever the agent observed via `web_fetch`, and returns ONE verdict:
 *
 *   PASS    — web date matches the computed date (confirmed; safe to remind)
 *   BLOCKED — web date DISAGREES, or couldn't be read → HOLD + ask the owner
 *             (never auto-adjust to the web value; a wrong web scrape must not move
 *             a real deadline). BLOCKED ≠ FAIL: we just couldn't safely confirm.
 *   SKIP    — no web observation supplied (verification not attempted this run);
 *             the caller may still proceed on the computed value but should say so.
 *
 * The computed `ad` date is ALWAYS the value the caller uses; this only decides
 * whether we can claim it was web-confirmed.
 */
import type { Verdict } from '../verification/verdict.js';

export interface DeadlineWebObservation {
  /** The deadline date the agent read on the IRD site, ISO `YYYY-MM-DD`. */
  observedAdIso: string;
  /** Where it was read (for the audit trail). */
  sourceUrl: string;
}

export interface DeadlineCheckResult {
  verdict: Verdict;
  /** The authoritative computed deadline (ISO) — ALWAYS what the caller uses. */
  computedAdIso: string;
  detail: string;
  /** Echoed for the audit log when a web observation was supplied. */
  source?: string;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reconcile the computed VAT filing deadline against an optional web observation.
 * `web` omitted → SKIP (proceed on the computed value, state it was not web-checked).
 */
export function checkFilingDeadline(
  computedAdIso: string,
  web?: DeadlineWebObservation,
): DeadlineCheckResult {
  if (!ISO_RE.test(computedAdIso)) {
    // a malformed computed date is a programming error, not a web problem.
    return { verdict: 'BLOCKED', computedAdIso, detail: `computed deadline is not ISO YYYY-MM-DD: ${computedAdIso}` };
  }
  if (!web) {
    return {
      verdict: 'SKIP',
      computedAdIso,
      detail: 'no IRD web observation supplied; proceeding on the computed deadline (not web-confirmed)',
    };
  }
  if (!ISO_RE.test(web.observedAdIso)) {
    return {
      verdict: 'BLOCKED',
      computedAdIso,
      source: web.sourceUrl,
      detail: `could not read a valid date from the IRD source (${web.sourceUrl}); holding — verify the deadline manually`,
    };
  }
  if (web.observedAdIso === computedAdIso) {
    return {
      verdict: 'PASS',
      computedAdIso,
      source: web.sourceUrl,
      detail: `IRD source confirms the filing deadline ${computedAdIso}`,
    };
  }
  // DISAGREEMENT: never adopt the web value silently. Hold and ask.
  return {
    verdict: 'BLOCKED',
    computedAdIso,
    source: web.sourceUrl,
    detail:
      `IRD source (${web.sourceUrl}) suggests ${web.observedAdIso} but the computed deadline is ` +
      `${computedAdIso}. Holding — do NOT state a deadline until the owner/accountant confirms which is right.`,
  };
}
