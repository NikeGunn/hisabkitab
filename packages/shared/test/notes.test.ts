import { describe, expect, it } from 'vitest';
import { computeNote, NoteError, type OriginalInvoice } from '../src/accounting/notes.js';
import { defaultTaxConfig } from '../src/config/tax.js';
import { vatOnExclusive } from '../src/vat/vat.js';

const cfg = defaultTaxConfig;

/** Original invoice: NPR 10,000 taxable + 13% VAT = 11,300 total (all in paisa). */
const original: OriginalInvoice = {
  taxablePaisa: 1_000_000n,
  vatPaisa: vatOnExclusive(1_000_000n, cfg), // 130_000n
  totalPaisa: 1_000_000n + vatOnExclusive(1_000_000n, cfg),
};

describe('computeNote (credit/debit notes)', () => {
  it('a partial credit note reconciles (taxable + vat == total)', () => {
    const taxable = 400_000n;
    const note = computeNote({ kind: 'credit', taxablePaisa: taxable, vatPaisa: vatOnExclusive(taxable, cfg) }, original, cfg);
    expect(note.totalPaisa).toBe(note.taxablePaisa + note.vatPaisa);
    expect(note.kind).toBe('credit');
  });

  it('a full credit note may equal the original exactly', () => {
    const note = computeNote(
      { kind: 'credit', taxablePaisa: original.taxablePaisa, vatPaisa: original.vatPaisa },
      original,
      cfg,
    );
    expect(note.totalPaisa).toBe(original.totalPaisa);
  });

  it('a debit note (under-bill correction) is allowed to exceed the original', () => {
    const taxable = original.taxablePaisa + 500_000n;
    const note = computeNote({ kind: 'debit', taxablePaisa: taxable, vatPaisa: vatOnExclusive(taxable, cfg) }, original, cfg);
    expect(note.taxablePaisa).toBe(taxable);
  });

  it('PROBE: a credit note larger than the original is REJECTED, never capped', () => {
    const taxable = original.taxablePaisa + 1n;
    expect(() =>
      computeNote({ kind: 'credit', taxablePaisa: taxable, vatPaisa: vatOnExclusive(taxable, cfg) }, original, cfg),
    ).toThrow(NoteError);
  });

  it('PROBE: a credit note whose VAT exceeds the original VAT is REJECTED', () => {
    // Same taxable as the original (so consistency passes), but VAT one paisa above the
    // original's VAT (within the rounding tolerance, so it is the VAT-ceiling guard that fires).
    expect(() =>
      computeNote(
        { kind: 'credit', taxablePaisa: original.taxablePaisa, vatPaisa: original.vatPaisa + 1n },
        original,
        cfg,
      ),
    ).toThrow(/VAT .* exceeds/);
  });

  it('PROBE: a bogus hand-entered VAT (inconsistent with the taxable base) is REJECTED', () => {
    // 400_000 taxable should carry ~52_000 VAT; claiming 90_000 is a lie.
    expect(() => computeNote({ kind: 'credit', taxablePaisa: 400_000n, vatPaisa: 90_000n }, original, cfg)).toThrow(
      /inconsistent/,
    );
  });

  it('PROBE: negative amounts are REJECTED', () => {
    expect(() => computeNote({ kind: 'credit', taxablePaisa: -1n, vatPaisa: 0n }, original, cfg)).toThrow(NoteError);
  });

  it('PROBE: a zero-value note is REJECTED', () => {
    expect(() => computeNote({ kind: 'credit', taxablePaisa: 0n, vatPaisa: 0n }, original, cfg)).toThrow(
      /positive amount/,
    );
  });

  it('tolerates 1-paisa rounding in the VAT figure', () => {
    const taxable = 333_333n;
    const exact = vatOnExclusive(taxable, cfg);
    // off by exactly 1 paisa: accepted
    expect(() => computeNote({ kind: 'credit', taxablePaisa: taxable, vatPaisa: exact + 1n }, original, cfg)).not.toThrow();
    // off by 2 paisa: rejected
    expect(() => computeNote({ kind: 'credit', taxablePaisa: taxable, vatPaisa: exact + 2n }, original, cfg)).toThrow(
      /inconsistent/,
    );
  });
});
