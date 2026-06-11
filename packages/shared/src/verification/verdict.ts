/**
 * One verdict taxonomy shared by human + agent + CI (CLAUDE.md §8):
 *   PASS    — observed the expected behaviour (including: the unit CAUGHT an adversarial probe)
 *   FAIL    — observed and wrong (e.g. the unit ACCEPTED a lying fixture)
 *   BLOCKED — couldn't observe/verify (≠ FAIL; when in doubt, do not pass → hold + ask)
 *   SKIP    — intentionally not run
 */
export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIP';

export interface VerdictResult {
  verdict: Verdict;
  detail: string;
}

export interface UnitCheck {
  /** Which shared unit this exercises: money | vat | tds | bsdate | aging | validation. */
  unit: string;
  name: string;
  /** 'probe' = adversarial fixture designed to be wrong, which the unit MUST catch. */
  kind: 'happy' | 'probe';
  run(): VerdictResult;
}

export const pass = (detail: string): VerdictResult => ({ verdict: 'PASS', detail });
export const fail = (detail: string): VerdictResult => ({ verdict: 'FAIL', detail });
export const blocked = (detail: string): VerdictResult => ({ verdict: 'BLOCKED', detail });

/** Run a check, converting unexpected throws into BLOCKED (couldn't observe ≠ observed wrong). */
export function runCheck(check: UnitCheck): VerdictResult {
  try {
    return check.run();
  } catch (err) {
    return blocked(`unexpected error while verifying: ${String(err)}`);
  }
}
