/**
 * Named, reproducible fixtures + invariants for every Phase 0 unit (CLAUDE.md §8).
 * Every unit has at least one adversarial PROBE — a fixture designed to be wrong
 * that the unit MUST catch. A probe PASSes when the lie is caught, FAILs if accepted.
 * The same checks run via `pnpm verify` (runtime), vitest (CI), or a human at a REPL.
 */
import { formatNpr, MoneyError, mulBps, nprToPaisa } from '../money/money.js';
import { splitVatInclusive, netVatPosition, inputCreditEligibility } from '../vat/vat.js';
import { computeTds, tdsBase } from '../tds/tds.js';
import { adToBs, bsToAd, BsDateError, vatFilingDeadline } from '../bsdate/bsdate.js';
import { buildAgingReport, verifyAgingReport, type AgingRow } from '../aging/aging.js';
import { validateExpense, type ExpenseCandidate } from '../validation/engine.js';
import { blocked, fail, pass, type UnitCheck } from './verdict.js';

// ---------------------------------------------------------------- shared fixtures

/** The canonical clean bill: taxable 8,000 + 13% VAT 1,040 = total 9,040 (PRD v1.1 §4.1). */
export const FIXTURE_CLEAN_BILL: ExpenseCandidate = {
  vendorName: 'Sharma Suppliers',
  vendorVatRegistered: true,
  invoiceNo: 'SS-1042',
  invoiceDate: new Date(2026, 4, 20), // 2026-05-20
  invoiceType: 'rule17',
  taxablePaisa: 800_000n,
  vatPaisa: 104_000n,
  totalPaisa: 904_000n,
  forTaxableBusinessUse: true,
};

/** PROBE: a ledger row whose totals do not reconcile (taxable+VAT ≠ total). Must be caught. */
export const PROBE_NON_RECONCILING_BILL: ExpenseCandidate = {
  ...FIXTURE_CLEAN_BILL,
  invoiceNo: 'SS-1043',
  vatPaisa: 100_000n, // claims VAT 1,000 on taxable 8,000 with total 9,040 — twice wrong
};

const ASOF = new Date(2026, 5, 11); // 2026-06-11

export const checks: UnitCheck[] = [
  // ---------------------------------------------------------------- money
  {
    unit: 'money',
    name: 'half-up rounding and lakh formatting',
    kind: 'happy',
    run() {
      const cases: Array<[bigint, number, bigint]> = [
        [100n, 1300, 13n], // 13% of Rs 1.00
        [50n, 1300, 7n], // 6.5 paisa rounds half-up to 7
        [1n, 5000, 1n], // 0.5 rounds up to 1
      ];
      for (const [amt, bps, expected] of cases) {
        const got = mulBps(amt, bps);
        if (got !== expected) return fail(`mulBps(${amt}, ${bps}) = ${got}, expected ${expected}`);
      }
      const formatted = formatNpr(123_456_789n);
      if (formatted !== 'Rs 12,34,567.89') return fail(`formatNpr → "${formatted}"`);
      if (nprToPaisa('9,040.50') !== 904_050n) return fail('nprToPaisa("9,040.50") wrong');
      return pass('rounding is half-up in exact integer math; NPR formats with lakh grouping');
    },
  },
  {
    unit: 'money',
    name: 'PROBE: precision-losing inputs are rejected, never silently rounded',
    kind: 'probe',
    run() {
      for (const bad of ['1.005', 'abc', '12.3.4'] as const) {
        try {
          nprToPaisa(bad);
          return fail(`accepted unparseable/3-decimal amount "${bad}"`);
        } catch (err) {
          if (!(err instanceof MoneyError)) return blocked(`wrong error type: ${String(err)}`);
        }
      }
      try {
        nprToPaisa(90.4); // float rupees — would corrupt paisa
        return fail('accepted a float amount 90.4');
      } catch (err) {
        if (!(err instanceof MoneyError)) return blocked(`wrong error type: ${String(err)}`);
      }
      return pass('floats and >2-decimal strings are refused with MoneyError');
    },
  },

  // ---------------------------------------------------------------- vat
  {
    unit: 'vat',
    name: 'inclusive split: 9,040 → 8,000 + 1,040; invariant excl+vat==total',
    kind: 'happy',
    run() {
      const { exclPaisa, vatPaisa } = splitVatInclusive(904_000n);
      if (exclPaisa !== 800_000n || vatPaisa !== 104_000n) {
        return fail(`split(904000) = ${exclPaisa}+${vatPaisa}`);
      }
      // invariant holds for awkward amounts too
      for (const total of [1n, 99n, 10_001n, 123_456_789n]) {
        const s = splitVatInclusive(total);
        if (s.exclPaisa + s.vatPaisa !== total) return fail(`invariant broke for ${total}`);
      }
      const pos = netVatPosition(50_000n, 80_000n);
      if (pos.netPayablePaisa !== 0n || pos.carryForwardPaisa !== 30_000n) {
        return fail('carry-forward: excess input must carry, never pay negative');
      }
      return pass('inclusive math, rounding and carry-forward match v1.1 §5.1');
    },
  },
  {
    unit: 'vat',
    name: 'PROBE: 17Ka bill claimed for input credit must be refused',
    kind: 'probe',
    run() {
      const decision = inputCreditEligibility(
        {
          vendorVatRegistered: true,
          invoiceType: 'rule17ka', // abbreviated — NOT valid for credit
          invoiceDate: new Date(2026, 4, 20),
          forTaxableBusinessUse: true,
        },
        ASOF,
      );
      if (decision.eligible) return fail('granted input credit on a Rule 17Ka abbreviated invoice');
      if (!decision.reasons.some((r) => r.includes('17Ka'))) {
        return fail(`refused, but without naming 17Ka: ${decision.reasons.join('; ')}`);
      }
      return pass('17Ka credit claim refused with an explicit reason');
    },
  },
  {
    unit: 'vat',
    name: 'PROBE: invoice older than 1 year must lose the credit window',
    kind: 'probe',
    run() {
      const decision = inputCreditEligibility(
        {
          vendorVatRegistered: true,
          invoiceType: 'rule17',
          invoiceDate: new Date(2025, 3, 1), // ~14 months before as-of
          forTaxableBusinessUse: true,
        },
        ASOF,
      );
      return decision.eligible
        ? fail('granted input credit outside the 1-year window')
        : pass(`credit blocked: ${decision.reasons.join('; ')}`);
    },
  },

  // ---------------------------------------------------------------- tds
  {
    unit: 'tds',
    name: 'service TDS branches: 1.5% VAT-registered vs 15% PAN-only, on the excl base',
    kind: 'happy',
    run() {
      const base = tdsBase(904_000n, 104_000n); // 800,000 paisa
      const reg = computeTds({ category: 'service_contract', baseExclVatPaisa: base, recipientVatRegistered: true });
      const pan = computeTds({ category: 'service_contract', baseExclVatPaisa: base, recipientVatRegistered: false });
      if (reg.kind !== 'computed' || reg.tdsPaisa !== 12_000n) return fail(`VAT-reg branch: ${JSON.stringify(reg, (_, v) => String(v))}`);
      if (pan.kind !== 'computed' || pan.tdsPaisa !== 120_000n) return fail('PAN-only branch wrong');
      const exempt = computeTds({ category: 'rent_land_building', baseExclVatPaisa: base, landlordIsIndividual: true });
      if (exempt.kind !== 'exempt') return fail('individual landlord rent must be exempt (88(5))');
      return pass('1.5%/15% service branches, excl-VAT base, landlord exemption all correct');
    },
  },
  {
    unit: 'tds',
    name: 'PROBE: salary TDS must refuse to estimate (progressive slabs)',
    kind: 'probe',
    run() {
      const d = computeTds({ category: 'salary', baseExclVatPaisa: 2_500_000n });
      return d.kind === 'ask_accountant'
        ? pass('salary returns ask_accountant instead of a guessed flat rate')
        : fail(`salary produced ${d.kind} — guessing a slab is forbidden`);
    },
  },

  // ---------------------------------------------------------------- bsdate
  {
    unit: 'bsdate',
    name: 'anchor + round-trip + filing deadline rollover',
    kind: 'happy',
    run() {
      const newYear = adToBs(new Date(2025, 3, 14)); // 14 Apr 2025 = 1 Baisakh 2082
      if (newYear.year !== 2082 || newYear.month !== 1 || newYear.day !== 1) {
        return fail(`2025-04-14 mapped to BS ${newYear.year}-${newYear.month}-${newYear.day}`);
      }
      const ad = bsToAd({ year: 2082, month: 4, day: 15 });
      const back = adToBs(ad);
      if (back.year !== 2082 || back.month !== 4 || back.day !== 15) return fail('round-trip drifted');
      const dl = vatFilingDeadline(2082, 12); // Chaitra → 25 Baisakh NEXT year
      if (dl.bs.year !== 2083 || dl.bs.month !== 1 || dl.bs.day !== 25) {
        return fail(`year-end deadline rolled to ${dl.bs.year}-${dl.bs.month}-${dl.bs.day}`);
      }
      return pass('BS anchor (1 Baisakh 2082 = 2025-04-14), round-trip, and 25th-of-next-month hold');
    },
  },
  {
    unit: 'bsdate',
    name: 'PROBE: impossible BS dates must throw, never roll over silently',
    kind: 'probe',
    run() {
      try {
        bsToAd({ year: 2082, month: 13, day: 1 });
        return fail('accepted BS month 13');
      } catch (err) {
        if (!(err instanceof BsDateError)) return blocked(`wrong error type: ${String(err)}`);
      }
      try {
        bsToAd({ year: 2082, month: 11, day: 32 }); // Falgun has fewer than 32 days
        return fail('accepted a day that does not exist in that month');
      } catch (err) {
        if (!(err instanceof BsDateError)) return blocked(`wrong error type: ${String(err)}`);
      }
      return pass('invalid BS dates raise BsDateError (treat as BLOCKED upstream, never guess)');
    },
  },

  // ---------------------------------------------------------------- aging
  {
    unit: 'aging',
    name: 'bucket boundaries and buckets-sum-to-total invariant',
    kind: 'happy',
    run() {
      const asOf = new Date(2026, 5, 11);
      const due = (daysAgo: number): Date => new Date(2026, 5, 11 - daysAgo);
      const rows: AgingRow[] = [
        { balancePaisa: 100n, dueOn: due(0) }, // current (due today)
        { balancePaisa: 200n, dueOn: due(1) }, // 1–30
        { balancePaisa: 300n, dueOn: due(30) }, // 1–30 boundary
        { balancePaisa: 400n, dueOn: due(31) }, // 31–60
        { balancePaisa: 500n, dueOn: due(90) }, // 61–90 boundary
        { balancePaisa: 600n, dueOn: due(91) }, // 90+
        { balancePaisa: 700n, dueOn: null }, // no due date — never guessed
      ];
      const report = buildAgingReport(rows, asOf);
      const b = report.buckets;
      const ok =
        b.current === 100n &&
        b.days1to30 === 500n &&
        b.days31to60 === 400n &&
        b.days61to90 === 500n &&
        b.days90plus === 600n &&
        b.noDueDate === 700n &&
        report.totalPaisa === 2800n;
      if (!ok) return fail(`buckets ${JSON.stringify(b, (_, v) => String(v))}`);
      const verified = verifyAgingReport(report, rows, asOf);
      return verified.result === 'pass'
        ? pass('boundaries at 30/31, 90/91 correct; buckets sum to the grand total')
        : fail(`self-verification failed: ${verified.reasons.join('; ')}`);
    },
  },
  {
    unit: 'aging',
    name: 'PROBE: a tampered report (inflated bucket) must fail verification',
    kind: 'probe',
    run() {
      const asOf = new Date(2026, 5, 11);
      const rows: AgingRow[] = [
        { balancePaisa: 1000n, dueOn: new Date(2026, 4, 1) },
        { balancePaisa: 2000n, dueOn: null },
      ];
      const report = buildAgingReport(rows, asOf);
      const tampered = {
        ...report,
        buckets: { ...report.buckets, days31to60: report.buckets.days31to60 + 5000n },
      };
      const verdict = verifyAgingReport(tampered, rows, asOf);
      return verdict.result === 'fail'
        ? pass(`tampering caught: ${verdict.reasons[0] ?? ''}`)
        : fail('a report that does not reconcile with the ledger was verified as correct');
    },
  },

  // ---------------------------------------------------------------- validation engine
  {
    unit: 'validation',
    name: 'clean bill passes every check and earns input credit',
    kind: 'happy',
    run() {
      const report = validateExpense(FIXTURE_CLEAN_BILL, { asOf: ASOF, existing: [] });
      if (report.overall !== 'pass') {
        return fail(
          `clean bill flagged: ${report.results.filter((r) => r.result !== 'pass').map((r) => r.reason).join('; ')}`,
        );
      }
      if (!report.inputCreditEligible) return fail('clean Rule 17 bill denied input credit');
      return pass('canonical 8,000+1,040=9,040 bill validates clean');
    },
  },
  {
    unit: 'validation',
    name: 'PROBE: non-reconciling ledger totals must be flagged, never passed',
    kind: 'probe',
    run() {
      const report = validateExpense(PROBE_NON_RECONCILING_BILL, { asOf: ASOF, existing: [] });
      if (report.overall === 'pass') return fail('accepted a bill whose taxable+VAT ≠ total');
      const flagged = report.results.filter((r) => r.result !== 'pass').map((r) => r.check);
      if (!flagged.includes('vat.totals') || !flagged.includes('vat.math')) {
        return fail(`flagged ${flagged.join(',')} but missed vat.totals/vat.math`);
      }
      return pass('both the VAT-math and totals reconciliation lies were caught');
    },
  },
  {
    unit: 'validation',
    name: 'PROBE: duplicate invoice must be flagged before saving',
    kind: 'probe',
    run() {
      const report = validateExpense(FIXTURE_CLEAN_BILL, {
        asOf: ASOF,
        existing: [
          {
            vendorName: 'sharma  suppliers', // case/whitespace differences must not hide it
            invoiceNo: 'ss-1042',
            totalPaisa: 904_000n,
            occurredOn: new Date(2026, 4, 20),
            recordedOn: new Date(2026, 4, 21),
          },
        ],
      });
      const dup = report.results.find((r) => r.check === 'duplicate');
      return dup?.result === 'warn'
        ? pass('duplicate (same vendor + invoice no) flagged as a warn for the owner to decide')
        : fail('a previously-recorded bill was not flagged as a possible duplicate');
    },
  },
  {
    unit: 'validation',
    name: 'PROBE: TDS computed on the VAT-inclusive amount must FAIL the save',
    kind: 'probe',
    run() {
      const report = validateExpense(
        {
          ...FIXTURE_CLEAN_BILL,
          tdsCategory: 'service_contract',
          recipientVatRegistered: true,
          claimedTdsPaisa: mulBps(904_000n, 150), // 1.5% of the TOTAL — illegal base
        },
        { asOf: ASOF, existing: [] },
      );
      const tds = report.results.find((r) => r.check === 'tds.base');
      if (report.overall !== 'fail' || tds?.result !== 'fail') {
        return fail('TDS-on-inclusive was not failed — a wrong legal base would have been saved');
      }
      return tds.reason.includes('INCLUSIVE')
        ? pass('caught and named: TDS base must exclude VAT')
        : pass(`caught (reason: ${tds.reason})`);
    },
  },
  {
    unit: 'validation',
    name: 'PROBE: negative and absurd amounts must FAIL, never save',
    kind: 'probe',
    run() {
      const neg = validateExpense(
        { ...FIXTURE_CLEAN_BILL, taxablePaisa: -800_000n },
        { asOf: ASOF, existing: [] },
      );
      if (neg.overall !== 'fail') return fail('negative taxable amount did not FAIL');
      const { vatPaisa: _vat, totalPaisa: _total, ...rest } = FIXTURE_CLEAN_BILL;
      const absurd = validateExpense(
        { ...rest, taxablePaisa: 10n ** 15n },
        { asOf: ASOF, existing: [] },
      );
      if (absurd.overall !== 'fail') return fail('absurdly large amount did not FAIL');
      return pass('range/sanity violations are hard FAILs (never save; ask the owner)');
    },
  },
];
