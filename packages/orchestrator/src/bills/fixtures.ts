/**
 * Phase 4 messy-bill fixture manifest (CLAUDE.md §8: named, reproducible
 * fixtures + adversarial probes). ONE source of truth shared by:
 *   - the renderer (what is printed on each dummy bill),
 *   - the deterministic vitest parity suite (manifest ↔ Validation Engine),
 *   - verify:bills (what the live agent must do with each image/PDF).
 * All figures are invented demo data; amounts are integer paisa.
 */
import { bsToAd, type ExpenseCandidate, type ExistingEntryRef } from '@hisab/shared';
import type { BillRenderSpec, BillMessiness } from './render.js';

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);
/** Recent enough to be inside the 1-year input-credit window. */
export const RECENT_AD = iso(daysAgo(20));
/** Outside the 1-year window — input credit must be denied. */
export const OLD_AD = iso(daysAgo(400));

export interface BillTruth {
  vendorName: string;
  vendorVatRegistered: boolean;
  invoiceNo?: string;
  invoiceDateAd: string;
  invoiceType: 'rule17' | 'rule17ka';
  /** undefined = not printed on the bill (e.g. 17Ka shows only a total). */
  taxablePaisa?: number;
  vatPaisa?: number;
  totalPaisa: number;
  isService: boolean;
}

export interface BillFixture {
  id: string;
  file: string;
  format: 'png' | 'pdf';
  mimeType: 'image/png' | 'application/pdf';
  /** Ground truth of what the bill ACTUALLY says (incl. printed lies). */
  truth: BillTruth;
  /** Skip engine parity for bills whose figures are unreadable by design. */
  engineCheckable: boolean;
  expected: {
    overall: 'pass' | 'warn' | 'fail';
    inputCreditEligible: boolean;
    /** Validation checks that MUST come back non-pass (the probe is caught). */
    mustFlag: string[];
  };
  /** Adversarial probe: the fixture is wrong/dangerous and must be caught. */
  probe: boolean;
  /** What the live agent must observably do with this bill. */
  behavior: string;
  render?: { spec: BillRenderSpec; messiness?: BillMessiness };
  pdfLines?: string[];
  /** Checked-in real-photo bills (fixtures/wild/) copied as-is, not rendered. */
  externalSource?: string;
}

// ------------------------------------------------------------------ fixtures

const cleanSpec: BillRenderSpec = {
  header: 'TAX INVOICE',
  vendorName: 'Gita Suppliers Pvt. Ltd.',
  vendorAddress: 'Newroad, Kathmandu, Nepal',
  taxIdLine: 'VAT No: 600123456',
  invoiceNo: 'GS-1142',
  dateLine: `Date (AD): ${RECENT_AD}`,
  buyerLine: 'Buyer: Sita Cafe, Patan (VAT: 600099999)',
  items: [
    ['Basmati Rice 25 kg', '3,500.00'],
    ['Cooking Oil 10 L', '2,800.00'],
    ['Sugar 30 kg', '1,700.00'],
  ],
  totals: [
    ['Sub Total', '8,000.00'],
    ['VAT 13%', '1,040.00'],
    ['Grand Total', '9,040.00'],
  ],
  footer: 'Thank you! Goods once sold are not returned.',
};

export const BILL_FIXTURES: BillFixture[] = [
  {
    id: 'clean-rule17',
    file: 'bill-clean-rule17.png',
    format: 'png',
    mimeType: 'image/png',
    truth: {
      vendorName: 'Gita Suppliers Pvt. Ltd.',
      vendorVatRegistered: true,
      invoiceNo: 'GS-1142',
      invoiceDateAd: RECENT_AD,
      invoiceType: 'rule17',
      taxablePaisa: 800_000,
      vatPaisa: 104_000,
      totalPaisa: 904_000,
      isService: false,
    },
    engineCheckable: true,
    expected: { overall: 'pass', inputCreditEligible: true, mustFlag: [] },
    probe: false,
    behavior: 'echo every field + figures, ask the owner to confirm; save only after an explicit yes',
    render: { spec: cleanSpec, messiness: { rotateDeg: 1.6 } },
  },
  {
    id: 'mismatch-total',
    file: 'bill-mismatch-total.png',
    format: 'png',
    mimeType: 'image/png',
    truth: {
      vendorName: 'Himal Traders',
      vendorVatRegistered: true,
      invoiceNo: 'HT-0877',
      invoiceDateAd: RECENT_AD,
      invoiceType: 'rule17',
      taxablePaisa: 800_000,
      vatPaisa: 104_000,
      totalPaisa: 954_000, // printed grand total LIES: 8,000 + 1,040 ≠ 9,540
      isService: false,
    },
    engineCheckable: true,
    expected: { overall: 'warn', inputCreditEligible: true, mustFlag: ['vat.totals'] },
    probe: true,
    behavior: 'flag that taxable + VAT does not equal the printed total; ask, never assert a reconciled figure',
    render: {
      spec: {
        header: 'TAX INVOICE',
        vendorName: 'Himal Traders',
        vendorAddress: 'Kalimati, Kathmandu',
        taxIdLine: 'VAT No: 600234567',
        invoiceNo: 'HT-0877',
        dateLine: `Date (AD): ${RECENT_AD}`,
        items: [
          ['Wai Wai Noodles (10 cartons)', '5,200.00'],
          ['Mineral Water (20 jars)', '2,800.00'],
        ],
        totals: [
          ['Sub Total', '8,000.00'],
          ['VAT 13%', '1,040.00'],
          ['Grand Total', '9,540.00'],
        ],
      },
      messiness: { rotateDeg: -1.2 },
    },
  },
  {
    id: 'abbreviated-17ka',
    file: 'bill-17ka.png',
    format: 'png',
    mimeType: 'image/png',
    truth: {
      vendorName: 'Pasal Mart',
      vendorVatRegistered: true,
      invoiceNo: 'PM-5531',
      invoiceDateAd: RECENT_AD,
      invoiceType: 'rule17ka',
      totalPaisa: 250_000, // VAT-inclusive; no VAT breakdown printed
      isService: false,
    },
    engineCheckable: true,
    expected: { overall: 'warn', inputCreditEligible: false, mustFlag: ['vat.input_credit'] },
    probe: true,
    behavior: 'abbreviated (17Ka) bill: must state input VAT credit is NOT claimable',
    render: {
      spec: {
        header: 'ABBREVIATED TAX INVOICE',
        vendorName: 'Pasal Mart',
        vendorAddress: 'Lagankhel, Lalitpur',
        taxIdLine: 'VAT No: 600345678',
        invoiceNo: 'PM-5531',
        dateLine: `Date (AD): ${RECENT_AD}`,
        items: [['Tea, snacks & sundries', '2,500.00']],
        totals: [['Total (incl. all taxes)', '2,500.00']],
        footer: 'Abbreviated invoice as per Rule 17Ka',
      },
      messiness: { rotateDeg: 2.1 },
    },
  },
  {
    id: 'missing-invoice-no',
    file: 'bill-missing-invoice-no.png',
    format: 'png',
    mimeType: 'image/png',
    truth: {
      vendorName: 'Everest Hardware',
      vendorVatRegistered: true,
      invoiceDateAd: RECENT_AD,
      invoiceType: 'rule17',
      taxablePaisa: 1_200_000,
      vatPaisa: 156_000,
      totalPaisa: 1_356_000,
      isService: false,
    },
    engineCheckable: true,
    // figures reconcile; the GAP is the smudged invoice number the agent must name + ask about
    expected: { overall: 'pass', inputCreditEligible: true, mustFlag: [] },
    probe: true,
    behavior: 'invoice number is smudged: must say it could not read it and ask — never invent one',
    render: {
      spec: {
        header: 'TAX INVOICE',
        vendorName: 'Everest Hardware',
        vendorAddress: 'Teku, Kathmandu',
        taxIdLine: 'VAT No: 600456789',
        smudgeInvoiceNo: true,
        dateLine: `Date (AD): ${RECENT_AD}`,
        items: [
          ['PVC Pipes (12 pc)', '7,400.00'],
          ['Paint 4 L', '4,600.00'],
        ],
        totals: [
          ['Sub Total', '12,000.00'],
          ['VAT 13%', '1,560.00'],
          ['Grand Total', '13,560.00'],
        ],
      },
      messiness: { rotateDeg: -1.8 },
    },
  },
  {
    id: 'blurry-unreadable',
    file: 'bill-blurry.png',
    format: 'png',
    mimeType: 'image/png',
    truth: {
      vendorName: 'Gita Suppliers Pvt. Ltd.', // what WAS printed; unrecoverable after blur
      vendorVatRegistered: true,
      invoiceNo: 'GS-1188',
      invoiceDateAd: RECENT_AD,
      invoiceType: 'rule17',
      taxablePaisa: 800_000,
      vatPaisa: 104_000,
      totalPaisa: 904_000,
      isService: false,
    },
    engineCheckable: false,
    expected: { overall: 'warn', inputCreditEligible: false, mustFlag: [] },
    probe: true,
    behavior: 'unreadable photo: must ask for a clearer photo and state NO figures at all',
    render: { spec: { ...cleanSpec, invoiceNo: 'GS-1188' }, messiness: { blurSigma: 14, rotateDeg: 1.0 } },
  },
  {
    id: 'duplicate-resend',
    file: 'bill-clean-rule17.png', // the SAME image sent again
    format: 'png',
    mimeType: 'image/png',
    truth: {
      vendorName: 'Gita Suppliers Pvt. Ltd.',
      vendorVatRegistered: true,
      invoiceNo: 'GS-1142',
      invoiceDateAd: RECENT_AD,
      invoiceType: 'rule17',
      taxablePaisa: 800_000,
      vatPaisa: 104_000,
      totalPaisa: 904_000,
      isService: false,
    },
    engineCheckable: true,
    expected: { overall: 'warn', inputCreditEligible: true, mustFlag: ['duplicate'] },
    probe: true,
    behavior: 'same vendor+invoice already recorded: must warn it looks like a duplicate and ask, not silently save again',
  },
  {
    id: 'old-bill-pdf',
    file: 'bill-old.pdf',
    format: 'pdf',
    mimeType: 'application/pdf',
    truth: {
      vendorName: 'Annapurna Press',
      vendorVatRegistered: true,
      invoiceNo: 'AP-2301',
      invoiceDateAd: OLD_AD,
      invoiceType: 'rule17',
      taxablePaisa: 400_000,
      vatPaisa: 52_000,
      totalPaisa: 452_000,
      isService: true,
    },
    engineCheckable: true,
    expected: { overall: 'warn', inputCreditEligible: false, mustFlag: ['vat.input_credit'] },
    probe: true,
    behavior: 'bill is over 1 year old: input credit window has lapsed — must say credit is not claimable',
    pdfLines: [
      'ANNAPURNA PRESS PVT. LTD.',
      'Bagbazar, Kathmandu  |  VAT No: 600567890',
      '',
      'TAX INVOICE',
      'Invoice No: AP-2301',
      `Date (AD): ${OLD_AD}`,
      'Buyer: Sita Cafe, Patan',
      '------------------------------------------',
      'Menu card design & printing      4,000.00',
      '------------------------------------------',
      'Sub Total                        4,000.00',
      'VAT 13%                            520.00',
      'Grand Total                      4,520.00',
    ],
  },
  {
    id: 'wild-real-photo',
    file: 'bill-wild-everest-buildcon.png',
    format: 'png',
    mimeType: 'image/png',
    externalSource: 'wild/everest-buildcon.png',
    // A real photographed construction-supplies tax invoice found in the wild:
    // BS-dated (2081/12/20), handwritten margin notes ("# Transport 3500
    // # Unloading 2500"), 2% discount line, and a printed VAT of 34,789.94
    // that is Rs 3 OFF the true 13% of the taxable 2,67,638.00 (= 34,792.94).
    truth: {
      vendorName: 'Everest BuildCon Pvt. Ltd.',
      vendorVatRegistered: true, // VAT No: 609876543
      invoiceNo: 'EBC/81/080',
      invoiceDateAd: iso(bsToAd({ year: 2081, month: 12, day: 20 })),
      invoiceType: 'rule17',
      taxablePaisa: 26_763_800,
      vatPaisa: 3_478_994,
      totalPaisa: 30_242_794, // internally consistent with the (wrong-rate) VAT
      isService: false,
    },
    engineCheckable: true,
    expected: {
      overall: 'warn',
      inputCreditEligible: false, // BS 2081/12/20 ≈ Apr 2025 — outside the 1-year window
      mustFlag: ['vat.math', 'vat.input_credit'],
    },
    probe: true,
    behavior:
      'real messy photo: VAT is not exactly 13% and the bill is over a year old — flag both, never present as clean; handwritten margin figures are NOT part of the invoice totals',
  },
];

/** Build the Validation Engine candidate exactly as the agent should after reading the bill. */
export function toCandidate(f: BillFixture): ExpenseCandidate {
  const t = f.truth;
  return {
    vendorName: t.vendorName,
    vendorVatRegistered: t.vendorVatRegistered,
    invoiceDate: new Date(`${t.invoiceDateAd}T00:00:00`),
    invoiceType: t.invoiceType,
    totalPaisa: BigInt(t.totalPaisa),
    forTaxableBusinessUse: true,
    ...(t.invoiceNo !== undefined ? { invoiceNo: t.invoiceNo } : {}),
    ...(t.taxablePaisa !== undefined ? { taxablePaisa: BigInt(t.taxablePaisa) } : {}),
    ...(t.vatPaisa !== undefined ? { vatPaisa: BigInt(t.vatPaisa) } : {}),
  };
}

/** The already-saved clean bill, as duplicate-detection context for the resend probe. */
export function cleanBillAsExisting(): ExistingEntryRef {
  const clean = BILL_FIXTURES.find((f) => f.id === 'clean-rule17');
  if (!clean) throw new Error('clean-rule17 fixture missing');
  return {
    id: '00000000-0000-0000-0000-000000000001',
    vendorName: clean.truth.vendorName,
    ...(clean.truth.invoiceNo !== undefined ? { invoiceNo: clean.truth.invoiceNo } : {}),
    totalPaisa: BigInt(clean.truth.totalPaisa),
    occurredOn: new Date(`${clean.truth.invoiceDateAd}T00:00:00`),
    recordedOn: new Date(),
  };
}

export const fixtureById = (id: string): BillFixture => {
  const f = BILL_FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`unknown bill fixture: ${id}`);
  return f;
};
