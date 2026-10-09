/**
 * VAT billing accuracy hardening (stored VAT must equal the tax invoice).
 *
 * - Known examples (Rs 999 inclusive, Rs 100 exclusive, smallest values, half ties).
 * - An INDEPENDENT oracle: exact rational nearest-integer search, not the production
 *   divRoundHalfUp formula, so a shared bug can't hide in both.
 * - Seeded property runs (seed printed in the test name → reproducible).
 * - resolveInvoiceVat: printed invoice figures stored exactly; probes that must reject.
 */
import { describe, expect, it } from 'vitest';
import { mulBps } from '../src/money/money.js';
import { resolveInvoiceVat, splitVatInclusive, vatOnExclusive } from '../src/vat/vat.js';
import { defaultTaxConfig } from '../src/config/tax.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_AMOUNT = defaultTaxConfig.maxAmountPaisa;

/** Deterministic PRNG (mulberry32) so every property run is reproducible from its seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random bigint in [1, max], spread across magnitudes (small values are where rounding bites). */
function randPaisa(rnd: () => number, max: bigint): bigint {
  const digits = 1 + Math.floor(rnd() * max.toString().length);
  let s = '';
  for (let i = 0; i < digits; i++) s += Math.floor(rnd() * 10).toString();
  const v = BigInt(s) % max;
  return v === 0n ? 1n : v;
}

/**
 * ORACLE — exact rational nearest integer to num/den, ties toward +infinity.
 * Compares the two candidate integers by exact distance; shares no code with money.ts.
 */
function oracleRound(num: bigint, den: bigint): bigint {
  const lo = num / den; // inputs here are non-negative, so `/` is floor
  const hi = lo + 1n;
  const dLo = num - lo * den; // distance × den
  const dHi = hi * den - num;
  return dHi <= dLo ? hi : lo;
}
const oracleSplit = (g: bigint) => {
  const excl = oracleRound(g * 100n, 113n);
  return { exclPaisa: excl, vatPaisa: g - excl };
};
const oracleVatOnExcl = (b: bigint) => oracleRound(b * 13n, 100n);

describe('known examples', () => {
  it('Rs 999.00 VAT-inclusive → Rs 884.07 taxable + Rs 114.93 VAT, reconciles exactly', () => {
    const s = splitVatInclusive(99_900n);
    expect(s).toEqual({ exclPaisa: 88_407n, vatPaisa: 11_493n });
    expect(s.exclPaisa + s.vatPaisa).toBe(99_900n);
  });

  it('Rs 100.00 VAT-exclusive → Rs 13.00 VAT, gross Rs 113.00', () => {
    expect(vatOnExclusive(10_000n)).toBe(1_300n);
  });

  it('smallest values: Rs 0.01 and Rs 0.02 inclusive keep every paisa', () => {
    expect(splitVatInclusive(1n)).toEqual({ exclPaisa: 1n, vatPaisa: 0n });
    expect(splitVatInclusive(2n)).toEqual({ exclPaisa: 2n, vatPaisa: 0n });
    expect(vatOnExclusive(1n)).toBe(0n); // 0.13 paisa → 0
    expect(vatOnExclusive(4n)).toBe(1n); // 0.52 paisa → 1
  });

  it('exclusive half-paisa tie rounds half-up: 50 paisa → 6.5 → 7', () => {
    expect(vatOnExclusive(50n)).toBe(7n);
    expect(vatOnExclusive(150n)).toBe(20n); // 19.5 → 20
  });

  it('just below / above an exclusive rounding boundary', () => {
    // 13% of 38 = 4.94 → 5 ; of 34 = 4.42 → 4 ; boundary .5 sits at 50/150/250...
    expect(vatOnExclusive(34n)).toBe(4n);
    expect(vatOnExclusive(38n)).toBe(5n);
    expect(vatOnExclusive(49n)).toBe(6n); // 6.37
    expect(vatOnExclusive(51n)).toBe(7n); // 6.63
  });

  it('PROOF: an inclusive split can never hit an exact half-paisa tie at 13%', () => {
    // a tie needs 200·G ≡ 113 (mod 226): even vs odd — impossible. Spot-check the claim.
    for (let g = 0n; g < 100_000n; g++) expect((200n * g) % 226n).not.toBe(113n);
  });

  it('very large amounts: the Rs 1 billion ceiling and MAX_SAFE_INTEGER stay exact', () => {
    for (const g of [MAX_AMOUNT, MAX_AMOUNT - 1n, MAX_SAFE, MAX_SAFE - 1n]) {
      const s = splitVatInclusive(g);
      expect(s).toEqual(oracleSplit(g));
      expect(s.exclPaisa + s.vatPaisa).toBe(g);
      // JSON boundary: both parts ≤ MAX_SAFE, so the tools' number serialization is exact.
      expect(s.exclPaisa <= MAX_SAFE && s.vatPaisa <= MAX_SAFE).toBe(true);
    }
  });
});

describe('property: production engine == independent oracle', () => {
  const SEED = 20_261_009;
  const RUNS = 20_000;
  const T = 30_000; // generous per-test timeout for slow CI runners

  it(
    `inclusive split, ${RUNS} amounts up to MAX_SAFE (seed ${SEED})`,
    () => {
      const rnd = prng(SEED);
      for (let i = 0; i < RUNS; i++) {
        const g = randPaisa(rnd, MAX_SAFE);
        const s = splitVatInclusive(g);
        expect(s).toEqual(oracleSplit(g));
        expect(s.exclPaisa + s.vatPaisa).toBe(g); // reconciles
        expect(s.vatPaisa >= 0n && s.exclPaisa >= 0n).toBe(true);
        expect(splitVatInclusive(g)).toEqual(s); // deterministic
      }
    },
    T,
  );

  it(
    `exclusive VAT, ${RUNS} amounts up to the Rs 1bn ceiling (seed ${SEED + 1})`,
    () => {
      const rnd = prng(SEED + 1);
      for (let i = 0; i < RUNS; i++) {
        const b = randPaisa(rnd, MAX_AMOUNT);
        expect(vatOnExclusive(b)).toBe(oracleVatOnExcl(b));
        expect(mulBps(b, 1300)).toBe(oracleVatOnExcl(b));
      }
    },
    T,
  );

  it(
    `ROUND-TRIP: an invoice-level-rounded bill (T, round(13%·T)) is recovered exactly from its total (seed ${SEED + 2})`,
    () => {
      // |round error| ≤ 0.5 paisa ⇒ |T − G/1.13| ≤ 0.5/1.13 < 0.5 ⇒ round(G/1.13) = T.
      const rnd = prng(SEED + 2);
      for (let i = 0; i < RUNS; i++) {
        const t = randPaisa(rnd, MAX_AMOUNT);
        const v = vatOnExclusive(t);
        expect(splitVatInclusive(t + v)).toEqual({ exclPaisa: t, vatPaisa: v });
      }
    },
    T,
  );
});

describe('resolveInvoiceVat', () => {
  const ok = (r: ReturnType<typeof resolveInvoiceVat>) => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    return r;
  };

  it('no printed figures → the computed 13% split (unchanged behaviour)', () => {
    expect(
      ok(resolveInvoiceVat({ amountPaisa: 99_900n, inclusive: true, vatApplies: true })),
    ).toMatchObject({
      exclPaisa: 88_407n,
      vatPaisa: 11_493n,
      source: 'computed',
    });
    expect(
      ok(resolveInvoiceVat({ amountPaisa: 10_000n, inclusive: false, vatApplies: true })),
    ).toMatchObject({
      exclPaisa: 10_000n,
      vatPaisa: 1_300n,
      source: 'computed',
    });
    expect(
      ok(resolveInvoiceVat({ amountPaisa: 50_000n, inclusive: true, vatApplies: false })),
    ).toMatchObject({
      exclPaisa: 50_000n,
      vatPaisa: 0n,
      source: 'computed',
    });
  });

  it('REGRESSION (the audit counterexample): a per-line-rounded bill keeps ITS VAT, not the re-derived one', () => {
    // Two lines of Rs 0.50: VAT per line 6.5 → 7 paisa, so the invoice prints T=100, V=14, G=114.
    // Re-deriving from G gives T=101, V=13 — one paisa off the legal tax invoice.
    expect(splitVatInclusive(114n)).toEqual({ exclPaisa: 101n, vatPaisa: 13n });
    const r = ok(
      resolveInvoiceVat({
        amountPaisa: 114n,
        inclusive: true,
        vatApplies: true,
        printed: { taxablePaisa: 100n, vatPaisa: 14n },
      }),
    );
    expect(r).toMatchObject({
      exclPaisa: 100n,
      vatPaisa: 14n,
      source: 'printed',
      computedVatPaisa: 13n,
    });
  });

  it(`property: per-line-rounded multi-line bills are stored exactly as printed and reconcile (seed 777)`, () => {
    const rnd = prng(777);
    let drifted = 0;
    for (let i = 0; i < 3_000; i++) {
      const lines = 1 + Math.floor(rnd() * 200); // up to 200 lines
      let t = 0n;
      let v = 0n;
      for (let l = 0; l < lines; l++) {
        const lt = randPaisa(rnd, 5_000_000n);
        t += lt;
        v += vatOnExclusive(lt);
      }
      const r = ok(
        resolveInvoiceVat({
          amountPaisa: t + v,
          inclusive: true,
          vatApplies: true,
          printed: { taxablePaisa: t, vatPaisa: v },
        }),
      );
      expect(r.exclPaisa).toBe(t);
      expect(r.vatPaisa).toBe(v);
      expect(r.exclPaisa + r.vatPaisa).toBe(t + v);
      if (r.computedVatPaisa !== v) drifted++;
    }
    // Proves the old re-derivation really diverged on a large share of such bills.
    expect(drifted).toBeGreaterThan(1_000);
  }, 30_000);

  it('line order does not change the stored result (sums are order-independent)', () => {
    const lineT = [50n, 150n, 34n, 9_999n, 1n];
    const fwd = lineT.reduce((a, t) => ({ t: a.t + t, v: a.v + vatOnExclusive(t) }), {
      t: 0n,
      v: 0n,
    });
    const rev = [...lineT]
      .reverse()
      .reduce((a, t) => ({ t: a.t + t, v: a.v + vatOnExclusive(t) }), { t: 0n, v: 0n });
    expect(fwd).toEqual(rev);
  });

  it('exclusive amount with matching printed figures → stored as printed', () => {
    expect(
      ok(
        resolveInvoiceVat({
          amountPaisa: 100n,
          inclusive: false,
          vatApplies: true,
          printed: { taxablePaisa: 100n, vatPaisa: 14n },
        }),
      ),
    ).toMatchObject({ exclPaisa: 100n, vatPaisa: 14n, source: 'printed' });
  });

  it('PROBE: printed taxable + VAT ≠ the total → rejected, nothing resolved', () => {
    const r = resolveInvoiceVat({
      amountPaisa: 113_000n,
      inclusive: true,
      vatApplies: true,
      printed: { taxablePaisa: 100_000n, vatPaisa: 12_500n },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not equal its total/);
  });

  it('PROBE: exclusive amount ≠ printed taxable → rejected', () => {
    const r = resolveInvoiceVat({
      amountPaisa: 100_000n,
      inclusive: false,
      vatApplies: true,
      printed: { taxablePaisa: 99_999n, vatPaisa: 13_000n },
    });
    expect(r.ok).toBe(false);
  });

  it('PROBE: VAT printed on a bill from a NON-VAT-registered vendor → rejected (never silently zeroed)', () => {
    const r = resolveInvoiceVat({
      amountPaisa: 113_000n,
      inclusive: true,
      vatApplies: false,
      printed: { taxablePaisa: 100_000n, vatPaisa: 13_000n },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/NOT VAT-registered/);
  });

  it('PROBE: negative printed figures and non-positive amounts → rejected', () => {
    expect(
      resolveInvoiceVat({
        amountPaisa: 100n,
        inclusive: true,
        vatApplies: true,
        printed: { taxablePaisa: 120n, vatPaisa: -20n },
      }).ok,
    ).toBe(false);
    expect(resolveInvoiceVat({ amountPaisa: 0n, inclusive: true, vatApplies: true }).ok).toBe(
      false,
    );
    expect(resolveInvoiceVat({ amountPaisa: -5n, inclusive: false, vatApplies: true }).ok).toBe(
      false,
    );
  });

  it('a printed VAT that is NOT 13% is still stored as printed (the Validation Engine warns; this never "fixes" it)', () => {
    expect(
      ok(
        resolveInvoiceVat({
          amountPaisa: 112_500n,
          inclusive: true,
          vatApplies: true,
          printed: { taxablePaisa: 100_000n, vatPaisa: 12_500n },
        }),
      ),
    ).toMatchObject({ vatPaisa: 12_500n, computedVatPaisa: 12_942n, source: 'printed' });
  });
});
