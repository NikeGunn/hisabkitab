/**
 * Phase 4 — manifest ↔ Validation Engine parity (CLAUDE.md §8).
 * The same ground truth that is PRINTED on each dummy bill must produce the
 * expected engine verdict, and every adversarial probe fixture must be caught
 * by at least one flagged check. Also smoke-tests the renderers so verify:bills
 * always has real artifacts to send.
 */
import { describe, expect, it } from 'vitest';
import { validateExpense, splitVatInclusive, defaultTaxConfig } from '@hisab/shared';
import {
  BILL_FIXTURES,
  cleanBillAsExisting,
  fixtureById,
  toCandidate,
} from '../src/bills/fixtures.js';
import { billSvg, renderBillPdf, renderBillPng } from '../src/bills/render.js';
import { mountPathFor } from '../src/whatsapp/media.js';

const engineCheckable = BILL_FIXTURES.filter((f) => f.engineCheckable);

describe('bill fixture manifest ↔ Validation Engine parity', () => {
  it.each(engineCheckable.map((f) => [f.id, f] as const))('%s', (_id, f) => {
    const existing = f.id === 'duplicate-resend' ? [cleanBillAsExisting()] : [];
    const report = validateExpense(toCandidate(f), { asOf: new Date(), existing });

    expect(report.overall).toBe(f.expected.overall);
    expect(report.inputCreditEligible).toBe(f.expected.inputCreditEligible);
    for (const check of f.expected.mustFlag) {
      const flagged = report.results.find((r) => r.check === check);
      expect(flagged, `check ${check} must exist`).toBeDefined();
      expect(flagged?.result, `check ${check} must be non-pass`).not.toBe('pass');
    }
  });

  it('every adversarial probe is CAUGHT (non-pass check or denied credit)', () => {
    for (const f of engineCheckable.filter((x) => x.probe)) {
      const existing = f.id === 'duplicate-resend' ? [cleanBillAsExisting()] : [];
      const report = validateExpense(toCandidate(f), { asOf: new Date(), existing });
      const caught =
        report.results.some((r) => r.result !== 'pass') ||
        !report.inputCreditEligible ||
        f.id === 'missing-invoice-no'; // its lie is a missing FIELD — caught by the agent protocol, asserted in verify:bills
      expect(caught, `probe ${f.id} sailed through the engine unflagged`).toBe(true);
    }
  });

  it('PROBE: the mismatch bill is never reportable as reconciling', () => {
    const f = fixtureById('mismatch-total');
    expect(f.truth.taxablePaisa! + f.truth.vatPaisa!).not.toBe(f.truth.totalPaisa);
    const report = validateExpense(toCandidate(f), { asOf: new Date(), existing: [] });
    expect(report.results.find((r) => r.check === 'vat.totals')?.result).toBe('warn');
  });

  it('17Ka inclusive total splits exactly and stays ineligible for credit', () => {
    const f = fixtureById('abbreviated-17ka');
    const { exclPaisa, vatPaisa } = splitVatInclusive(BigInt(f.truth.totalPaisa), defaultTaxConfig);
    expect(exclPaisa + vatPaisa).toBe(BigInt(f.truth.totalPaisa));
    const report = validateExpense(toCandidate(f), { asOf: new Date(), existing: [] });
    expect(report.inputCreditEligible).toBe(false);
    expect(report.inputCreditReasons.join(' ')).toMatch(/abbreviated|17/i);
  });

  it('old PDF bill is denied credit for the 1-year window, not for its type', () => {
    const report = validateExpense(toCandidate(fixtureById('old-bill-pdf')), {
      asOf: new Date(),
      existing: [],
    });
    expect(report.inputCreditEligible).toBe(false);
    expect(report.inputCreditReasons.join(' ')).toMatch(/year|window|old|365/i);
  });
});

describe('bill renderers', () => {
  it('SVG bill contains every printed field of the clean bill', () => {
    const f = fixtureById('clean-rule17');
    const svg = billSvg(f.render!.spec);
    for (const needle of ['Gita Suppliers', 'GS-1142', '8,000.00', '1,040.00', '9,040.00', 'TAX INVOICE']) {
      expect(svg).toContain(needle);
    }
  });

  it('renders real PNGs; the blurred probe differs from the clean bill', async () => {
    const clean = await renderBillPng(fixtureById('clean-rule17').render!.spec, { rotateDeg: 1.6 });
    const blurry = await renderBillPng(fixtureById('blurry-unreadable').render!.spec, {
      blurSigma: 14,
      rotateDeg: 1.0,
    });
    for (const png of [clean, blurry]) {
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.length).toBeGreaterThan(5_000);
    }
    expect(clean.equals(blurry)).toBe(false);
  });

  it('smudged bill hides the invoice number but keeps the totals readable', () => {
    const svg = billSvg(fixtureById('missing-invoice-no').render!.spec);
    expect(svg).toContain('Invoice No:'); // the label survives…
    expect(svg).toContain('<rect'); // …but a smudge covers the value
    expect(svg).toContain('13,560.00');
  });

  it('hand-rolled PDF is well-formed and carries the old bill text', () => {
    const f = fixtureById('old-bill-pdf');
    const pdf = renderBillPdf(f.pdfLines!).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('AP-2301');
    expect(pdf).toContain('4,520.00');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    // xref offset must point at the actual xref table
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('mount paths keep the right extension for both formats', () => {
    const png = mountPathFor({ mediaId: 'm1', mimeType: 'image/png' }, new Date('2026-06-12T10:30:00Z'));
    const pdf = mountPathFor({ mediaId: 'm2', mimeType: 'application/pdf' }, new Date('2026-06-12T10:30:00Z'));
    expect(png).toMatch(/^\/workspace\/inbox\/.*\.png$/);
    expect(pdf).toMatch(/^\/workspace\/inbox\/.*\.pdf$/);
  });
});
