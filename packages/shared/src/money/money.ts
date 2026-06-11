/**
 * Money = integer paisa (bigint). 1 NPR = 100 paisa. Never floats.
 * All arithmetic here is EXACT integer math — division rounds half-up
 * (toward +infinity at exactly .5), per PRD v1.1 §5.1 "integer paisa, round half-up".
 */

export type Paisa = bigint;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Floor division for bigints (truncates toward -infinity, unlike `/`). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** Divide and round half-up: round(n/d) where exactly-half rounds toward +infinity. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError(`denominator must be positive, got ${denominator}`);
  return floorDiv(2n * numerator + denominator, 2n * denominator);
}

/** amount × (bps/10000), rounded half-up. 1300 bps = 13%. */
export function mulBps(amountPaisa: Paisa, bps: number | bigint): Paisa {
  const b = BigInt(bps);
  if (b < 0n) throw new MoneyError(`bps must be non-negative, got ${b}`);
  return divRoundHalfUp(amountPaisa * b, 10_000n);
}

const NPR_STRING = /^-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?$|^-?\d+(?:\.\d{1,2})?$/;

/**
 * Parse a rupee amount into paisa. Accepts integer rupees (number|bigint) or a
 * decimal string with at most 2 decimal places ("9,040.50"). Anything that could
 * lose precision (floats, 3+ decimals) is rejected — never silently rounded.
 */
export function nprToPaisa(amount: string | number | bigint): Paisa {
  if (typeof amount === 'bigint') return amount * 100n;
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) {
      throw new MoneyError(
        `refusing non-integer number ${amount} — pass a string ("${amount}") to keep paisa exact`,
      );
    }
    return BigInt(amount) * 100n;
  }
  const s = amount.trim().replace(/^Rs\.?\s*/i, '');
  if (!NPR_STRING.test(s)) throw new MoneyError(`cannot parse NPR amount: "${amount}"`);
  const clean = s.replace(/,/g, '');
  const [rupees = '0', frac = ''] = clean.replace('-', '').split('.');
  const paisa = BigInt(rupees) * 100n + BigInt(frac.padEnd(2, '0') || '0');
  return clean.startsWith('-') ? -paisa : paisa;
}

/** Format paisa as NPR with Nepali (lakh/crore) digit grouping: 12,34,567.89 */
export function formatNpr(paisa: Paisa): string {
  const neg = paisa < 0n;
  const abs = neg ? -paisa : paisa;
  const rupees = (abs / 100n).toString();
  const fraction = (abs % 100n).toString().padStart(2, '0');
  let grouped = rupees;
  if (rupees.length > 3) {
    const head = rupees.slice(0, -3);
    const tail = rupees.slice(-3);
    grouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
  }
  return `${neg ? '-' : ''}Rs ${grouped}.${fraction}`;
}
