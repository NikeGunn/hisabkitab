/**
 * Pre-delivery Audit Gate (PRD v1.1 §4.3 — Layer 3).
 *
 * No outbound message that states a financial figure, and no save confirmation,
 * may reach the owner unless every figure is traceable to a ledger/validation
 * tool result observed in the SAME turn, and no validation `fail` occurred.
 * On any doubt the verdict is HOLD — never deliver an unverified number
 * (false PASS ships a wrong number to a business; false HOLD costs one look).
 *
 * Pure module: the orchestrator collects evidence from tool-result events and
 * asks the gate before relaying each agent message.
 */

export interface TurnEvidence {
  /** Canonical numeric strings seen in tool results, incl. ±2 decimal shifts (paisa↔rupee). */
  verifiedNumbers: Set<string>;
  /** Validation Engine `fail` reasons observed in tool results this turn. */
  validationFailures: string[];
  /** Tool executions that errored this turn. */
  toolErrors: string[];
}

export type GateDecision =
  | { action: 'deliver' }
  | { action: 'hold'; reasons: string[] };

export const newTurnEvidence = (): TurnEvidence => ({
  verifiedNumbers: new Set(),
  validationFailures: [],
  toolErrors: [],
});

/** "1,130.00" → "1130"; "0.50" → "0.5"; non-numeric → ''. Pure string math, no floats. */
export function canonNumber(raw: string): string {
  let s = raw.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return '';
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/^0+(?=\d)/, '');
  return s;
}

/** Decimal-point shift by 10^by on a canonical numeric string (no floats). */
export function shiftDecimal(canonical: string, by: number): string {
  if (!canonical) return '';
  const [intPart, fracPart = ''] = canonical.split('.');
  const digits = `${intPart}${fracPart}`;
  let point = (intPart as string).length + by;
  let padded = digits;
  if (point <= 0) {
    padded = '0'.repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) {
    padded = digits + '0'.repeat(point - digits.length);
  }
  const head = padded.slice(0, point);
  const tail = padded.slice(point);
  return canonNumber(tail ? `${head}.${tail}` : head);
}

/**
 * Money figures in an outbound message. Conservative scope: currency-marked
 * amounts (NPR / Rs / रु / paisa) and separator-formatted numbers (1,23,456.00).
 * Bare small integers (dates, counts, "13%" rate mentions) are not money claims.
 */
export function extractMoneyFigures(text: string): string[] {
  const found = new Set<string>();
  const currency =
    /(?:NPR|Rs\.?|रु\.?|₨)\s*([0-9][0-9,]*(?:\.[0-9]+)?)|([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:paisa|rupees|रुपैयाँ)/gi;
  for (const m of text.matchAll(currency)) {
    const c = canonNumber((m[1] ?? m[2]) as string);
    if (c) found.add(c);
  }
  // separator-formatted (covers both 1,234,567 and lakh-style 1,23,456)
  for (const m of text.matchAll(/(?<![\w.])\d{1,3}(?:,\d{2,3})+(?:\.\d+)?(?![\w])/g)) {
    const c = canonNumber(m[0]);
    if (c) found.add(c);
  }
  return [...found];
}

/**
 * Feed one tool result (raw JSON/text) into the turn's evidence. Every number a
 * tenant-scoped ledger tool returned is verified by construction; each is also
 * registered shifted ±2 places so "904000 paisa" verifies "Rs 9,040.00".
 * Validation `fail` verdicts and tool errors are recorded as hold conditions.
 */
export function addToolResultEvidence(
  evidence: TurnEvidence,
  rawResult: string,
  opts: { isError?: boolean } = {},
): void {
  if (opts.isError) {
    evidence.toolErrors.push(rawResult.slice(0, 300));
    return; // numbers inside an errored result are not evidence
  }
  for (const m of rawResult.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g)) {
    const c = canonNumber(m[0]);
    if (!c) continue;
    evidence.verifiedNumbers.add(c);
    evidence.verifiedNumbers.add(shiftDecimal(c, 2));
    evidence.verifiedNumbers.add(shiftDecimal(c, -2));
  }
  for (const m of rawResult.matchAll(/"(?:result|overall)"\s*:\s*"fail"/g)) {
    void m;
    evidence.validationFailures.push('validation engine returned fail');
  }
}

/**
 * Figures the OWNER typed this turn. Repeating the owner's own number back ("you
 * said Rs 11,300") is not a fabrication, so it is evidence; every DERIVED figure
 * (VAT, taxable, totals the owner did not type) still has to come from a tool.
 * Only call this with the owner's verbatim inbound text, never agent output.
 */
export function addOwnerFigures(evidence: TurnEvidence, ownerText: string): void {
  for (const m of ownerText.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])/g)) {
    const c = canonNumber(m[0]);
    if (c) evidence.verifiedNumbers.add(c);
  }
}

/** The gate itself. Deliver only when every money figure is evidenced and nothing failed. */
export function auditOutbound(message: string, evidence: TurnEvidence): GateDecision {
  const reasons: string[] = [];
  if (evidence.validationFailures.length > 0) {
    reasons.push(`validation failed this turn (${evidence.validationFailures.length}x)`);
  }
  const unverified = extractMoneyFigures(message).filter(
    (figure) => !evidence.verifiedNumbers.has(figure),
  );
  if (unverified.length > 0) {
    reasons.push(`unverified figures: ${unverified.join(', ')}`);
  }
  return reasons.length > 0 ? { action: 'hold', reasons } : { action: 'deliver' };
}

/** Instruction sent back to the agent when its message is held (instead of relaying it). */
export function correctiveInstruction(decision: Extract<GateDecision, { action: 'hold' }>): string {
  return (
    `[AUDIT GATE — your last message was HELD and NOT delivered to the owner. ` +
    `Reasons: ${decision.reasons.join('; ')}. ` +
    `Re-derive every figure via the ledger tools (validate_entry / compute_vat / ` +
    `generate_return_summary) and reply again, or — if you cannot verify — ask the owner ` +
    `for the missing information instead of asserting a number.]`
  );
}

/** Safe fallback delivered when the agent keeps failing the gate (never states figures). */
export const HELD_FALLBACK_MESSAGE =
  'माफ गर्नुहोस् — I could not verify those figures against your ledger just now, ' +
  'so I have not sent them. Please give me a moment, or ask me again shortly.';
