/**
 * Exact Tally-amount parsing (PURE). Tally XML carries amounts as decimal strings
 * (e.g. "-12345.67"). Money NEVER passes through binary floating point: we parse the
 * digits directly into integer paisa (bigint), then expose the platform wire shape
 * (integer paisa number + explicit side).
 *
 * SIGN CONVENTION (single source of truth, tested in tally.test.ts):
 * TallyPrime XML balance fields are **negative = debit, positive = credit**. Zero is
 * normalized to a debit side with zero magnitude (side is meaningless at zero, but a
 * fixed choice keeps outputs deterministic).
 */
import type { TallyBalance } from './types.js';

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

export class TallyAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyAmountError';
  }
}

/**
 * Parse a Tally decimal string into SIGNED bigint paisa, digit-exact.
 * Rejects (never guesses): empty, grouping commas, exponents, currency symbols,
 * more than 2 fraction digits (would silently lose sub-paisa — refuse instead).
 */
export function parseTallyAmountPaisa(raw: string): bigint {
  const s = raw.trim();
  if (!AMOUNT_RE.test(s)) {
    throw new TallyAmountError(`unparseable Tally amount ${JSON.stringify(raw)}`);
  }
  const negative = s.startsWith('-');
  const [intPart = '0', fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  const paisa = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, '0') || '0');
  return negative ? -paisa : paisa;
}

/** Max integer paisa that survives the JSON wire (platform-wide invariant). */
const MAX_WIRE_PAISA = BigInt(Number.MAX_SAFE_INTEGER);

/** Signed bigint paisa → wire-safe integer paisa number. Throws instead of losing precision. */
export function paisaToWire(paisa: bigint): number {
  const abs = paisa < 0n ? -paisa : paisa;
  if (abs > MAX_WIRE_PAISA)
    throw new TallyAmountError(`amount exceeds wire-safe integer paisa: ${paisa}`);
  return Number(paisa);
}

/** Tally signed balance string → normalized {paisa, side} (negative-is-debit rule). */
export function tallyAmountToBalance(raw: string): TallyBalance {
  const signed = parseTallyAmountPaisa(raw);
  return signedPaisaToBalance(paisaToWire(signed));
}

/**
 * Signed wire paisa (Tally convention: negative = debit) → {paisa, side}.
 * Inverse of `balanceToSignedPaisa`; the pair is round-trip tested.
 */
export function signedPaisaToBalance(signed: number): TallyBalance {
  if (!Number.isSafeInteger(signed))
    throw new TallyAmountError(`not a wire-safe integer paisa: ${signed}`);
  // `signed + 0` also normalizes −0 → 0 so a zero balance never carries a negative zero.
  return signed <= 0 ? { paisa: -signed + 0, side: 'debit' } : { paisa: signed, side: 'credit' };
}

/** {paisa, side} → signed paisa in the Tally convention (debit negative). */
export function balanceToSignedPaisa(b: TallyBalance): number {
  if (!Number.isSafeInteger(b.paisa) || b.paisa < 0) {
    throw new TallyAmountError(
      `balance magnitude must be a non-negative safe integer, got ${b.paisa}`,
    );
  }
  return b.side === 'debit' ? -b.paisa + 0 : b.paisa; // `+ 0` normalizes −0 → 0
}
