/**
 * P13 — accounting completeness (PRD v2.0 §12): gap-free sequential VAT invoice
 * numbering + credit/debit notes. Same discipline as arap-tools.ts: every write is
 * ONE tenant-scoped tx (RLS), validated before save, notes land as `draft` until
 * confirm, and every action appends audit_log.
 *
 *  - Numbering is allocated under SELECT … FOR UPDATE on the per-(tenant, fiscal-year)
 *    sequence row, so two concurrent allocations serialize: no number is ever reused
 *    or skipped (IRD Rule-17). The series resets each BS fiscal year (Shrawan–Ashadh).
 *  - A confirmed invoice is NEVER edited. A return / cancellation / correction is a
 *    credit (reduces) or debit (increases) note that REFERENCES the original; its
 *    figures are validated by the pure @hisab/shared `computeNote` (a credit can't
 *    exceed the original; VAT must be coherent with the taxable base).
 */
import { z } from 'zod';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { appendAudit, schema, type Tx } from '@hisab/db';
import {
  adToBs,
  annualVatSummary,
  bsFiscalYear,
  bsFiscalYearLabel,
  bsMonthRange,
  computeNote,
  computeOpening,
  defaultTaxConfig,
  splitVatInclusive,
  tdsDepositDeadline,
  vatOnExclusive,
  type MonthlyVat,
  type TaxConfig,
} from '@hisab/shared';
import type { ToolContext } from './tools.js';

const { invoiceSequences, creditNotes, arInvoices, expenses, sales, parties, openingBalances } =
  schema;

// ---------------------------------------------------------------- zod building blocks
const paisa = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('integer paisa (1 NPR = 100 paisa)');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const uuid = z.string().uuid();

export const accountingInputSchemas = {
  next_invoice_number: {
    issued_on: isoDate.describe('the AD issue date; its BS fiscal year selects the series'),
    series: z
      .enum(['invoice', 'note'])
      .default('invoice')
      .describe('prefix only — both share one gap-free series'),
  },
  issue_note: {
    original_invoice_id: uuid.describe('the CONFIRMED AR invoice this note adjusts'),
    kind: z
      .enum(['credit', 'debit'])
      .describe('credit = reduce/return; debit = under-bill correction'),
    issued_on: isoDate,
    amount_paisa: paisa.describe('the amount being adjusted, VAT-inclusive unless inclusive=false'),
    inclusive: z.boolean().default(true).describe('amount includes 13% VAT (default true)'),
    reason: z.string().max(500).optional(),
  },
  confirm_note: {
    note_id: uuid,
  },
  generate_tds_summary: {
    bs_year: z.number().int().min(2000).max(2200),
    bs_month: z.number().int().min(1).max(12),
  },
  record_opening_balance: {
    kind: z
      .enum(['receivable', 'payable', 'vat_credit'])
      .describe('open debtor (receivable), open creditor (payable), or carried VAT credit'),
    amount_paisa: paisa.describe('the OPEN amount as of the cutover, integer paisa, > 0'),
    as_of: isoDate.describe(
      'the cutover date this balance is true as of (its BS fiscal year is derived)',
    ),
    party_id: uuid
      .optional()
      .describe('REQUIRED for receivable/payable (the debtor/creditor); omit for vat_credit'),
    note: z.string().max(500).optional(),
  },
  confirm_opening_balance: {
    opening_id: uuid,
  },
  get_annual_summary: {
    fiscal_year: z
      .number()
      .int()
      .min(2000)
      .max(2200)
      .describe('BS fiscal year (start year, Shrawan-based), e.g. 2082 = FY 2082/83'),
  },
} as const;

export const accountingToolDescriptions: Record<keyof typeof accountingInputSchemas, string> = {
  next_invoice_number:
    'Allocate the NEXT gap-free sequential VAT invoice/note number for the fiscal year of issued_on (IRD Rule-17). Numbers are never reused or skipped and reset each BS fiscal year. Returns the formatted number (e.g. "2082/83-0007").',
  issue_note:
    'Issue a credit (reduce/return) or debit (under-bill correction) note against a CONFIRMED AR invoice, as a DRAFT. Never edits the original invoice. A credit note cannot exceed the original amounts; VAT is recomputed, never hand-entered. Validation fail → nothing saved.',
  confirm_note:
    'Flip a draft credit/debit note to confirmed. Call ONLY after the owner explicitly confirmed.',
  generate_tds_summary:
    'Deterministically total the TDS WITHHELD on confirmed expenses in a BS month and return the deposit deadline (25th of the following BS month). Read-only — prepares the figure; the owner deposits via eTDS. Never invents a figure.',
  record_opening_balance:
    'Seed an OPENING balance for a mid-year onboarding business: an open debtor (receivable), open creditor (payable), or carried VAT credit (vat_credit), as a DRAFT. receivable/payable require party_id. Owner-asserted; validated and saved draft until confirmed.',
  confirm_opening_balance:
    'Flip a draft opening balance to confirmed. Call ONLY after the owner explicitly confirmed.',
  get_annual_summary:
    'Roll the VAT carry-forward across a whole BS fiscal year (Shrawan–Ashadh) from confirmed entries: per-month settlement, annual output/input/net-payable totals, and the credit carried into the next fiscal year. Read-only, deterministic.',
};

type Args<K extends keyof typeof accountingInputSchemas> = z.infer<
  z.ZodObject<(typeof accountingInputSchemas)[K]>
>;

const n = (b: bigint): number => Number(b);
const toDate = (iso: string): Date => {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const toIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The 12 BS months of a fiscal year in chronological order: Shrawan(4)…Chaitra(12), Baisakh(1)…Ashadh(3). */
const FISCAL_MONTHS: ReadonlyArray<{ year: 'fy' | 'next'; month: number }> = [
  { year: 'fy', month: 4 },
  { year: 'fy', month: 5 },
  { year: 'fy', month: 6 },
  { year: 'fy', month: 7 },
  { year: 'fy', month: 8 },
  { year: 'fy', month: 9 },
  { year: 'fy', month: 10 },
  { year: 'fy', month: 11 },
  { year: 'fy', month: 12 },
  { year: 'next', month: 1 },
  { year: 'next', month: 2 },
  { year: 'next', month: 3 },
];

/** Split a VAT-inclusive/exclusive amount into taxable + VAT (reuses the shared pure fns). */
function splitAmount(
  amountPaisa: bigint,
  inclusive: boolean,
  cfg: TaxConfig,
): { taxablePaisa: bigint; vatPaisa: bigint } {
  // VAT always applies to an AR note (the original was a VAT invoice).
  if (inclusive) {
    const { exclPaisa, vatPaisa } = splitVatInclusive(amountPaisa, cfg);
    return { taxablePaisa: exclPaisa, vatPaisa };
  }
  return { taxablePaisa: amountPaisa, vatPaisa: vatOnExclusive(amountPaisa, cfg) };
}

/**
 * Allocate the next number under a row lock. The sequence row is created on first use
 * (ON CONFLICT DO NOTHING), then bumped with `last_number = last_number + 1 RETURNING`,
 * which Postgres serializes on the row — concurrent callers queue, none collide.
 */
async function allocateNumber(tx: Tx, tenantId: string, fiscalYear: number): Promise<number> {
  await tx
    .insert(invoiceSequences)
    .values({ tenantId, fiscalYear, lastNumber: 0 })
    .onConflictDoNothing({ target: [invoiceSequences.tenantId, invoiceSequences.fiscalYear] });
  const [row] = await tx
    .update(invoiceSequences)
    .set({ lastNumber: sql`${invoiceSequences.lastNumber} + 1` })
    .where(
      and(eq(invoiceSequences.tenantId, tenantId), eq(invoiceSequences.fiscalYear, fiscalYear)),
    )
    .returning({ lastNumber: invoiceSequences.lastNumber });
  return row!.lastNumber;
}

/** Format an allocated number as "<FY label>-<4-digit seq>", e.g. "2082/83-0007". */
function formatNumber(fiscalYear: number, seq: number): string {
  return `${bsFiscalYearLabel(fiscalYear)}-${String(seq).padStart(4, '0')}`;
}

export function createAccountingToolHandlers(ctx: ToolContext) {
  const { db, tenantId, cfg } = ctx;
  const inTenantTx = <T>(fn: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });

  return {
    async next_invoice_number(args: Args<'next_invoice_number'>) {
      const fy = bsFiscalYear(adToBs(toDate(args.issued_on)));
      return inTenantTx(async (tx) => {
        const seq = await allocateNumber(tx, tenantId, fy);
        const number = formatNumber(fy, seq);
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'next_invoice_number',
          detail: { fiscal_year: fy, seq, number, series: args.series },
        });
        return { fiscal_year: fy, fiscal_year_label: bsFiscalYearLabel(fy), sequence: seq, number };
      });
    },

    async issue_note(args: Args<'issue_note'>) {
      const { taxablePaisa, vatPaisa } = splitAmount(
        BigInt(args.amount_paisa),
        args.inclusive,
        cfg,
      );
      return inTenantTx(async (tx) => {
        // The note must reference a CONFIRMED invoice in THIS tenant (RLS already scopes).
        const [inv] = await tx
          .select({
            id: arInvoices.id,
            status: arInvoices.status,
            taxablePaisa: arInvoices.taxablePaisa,
            vatPaisa: arInvoices.vatPaisa,
            totalPaisa: arInvoices.totalPaisa,
            issuedOn: arInvoices.issuedOn,
          })
          .from(arInvoices)
          .where(
            and(eq(arInvoices.tenantId, tenantId), eq(arInvoices.id, args.original_invoice_id)),
          );
        if (!inv)
          return { saved: false as const, reason: 'original invoice not found in this business' };
        if (inv.status !== 'confirmed') {
          return {
            saved: false as const,
            reason:
              'a note can only adjust a CONFIRMED invoice — confirm or edit the draft instead',
          };
        }

        let figures;
        try {
          figures = computeNote(
            { kind: args.kind, taxablePaisa, vatPaisa },
            { taxablePaisa: inv.taxablePaisa, vatPaisa: inv.vatPaisa, totalPaisa: inv.totalPaisa },
            cfg,
          );
        } catch (err) {
          await appendAudit(tx, tenantId, {
            actor: 'agent',
            action: 'issue_note.rejected',
            detail: {
              invoice_id: inv.id,
              reason: err instanceof Error ? err.message : String(err),
            },
          });
          return {
            saved: false as const,
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        const fy = bsFiscalYear(adToBs(toDate(args.issued_on)));
        const noteNo = formatNumber(fy, await allocateNumber(tx, tenantId, fy));
        const [row] = await tx
          .insert(creditNotes)
          .values({
            tenantId,
            originalInvoiceId: inv.id,
            kind: figures.kind,
            noteNo,
            issuedOn: args.issued_on,
            taxablePaisa: figures.taxablePaisa,
            vatPaisa: figures.vatPaisa,
            totalPaisa: figures.totalPaisa,
            reason: args.reason ?? null,
          })
          .returning({ id: creditNotes.id });
        const noteId = row!.id;
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'issue_note.draft',
          detail: {
            note_id: noteId,
            kind: figures.kind,
            invoice_id: inv.id,
            total_paisa: n(figures.totalPaisa),
          },
        });
        return {
          saved: true as const,
          note_id: noteId,
          note_no: noteNo,
          kind: figures.kind,
          status: 'draft' as const,
          original_invoice_id: inv.id,
          taxable_paisa: n(figures.taxablePaisa),
          vat_paisa: n(figures.vatPaisa),
          total_paisa: n(figures.totalPaisa),
          assumption: args.inclusive
            ? 'amount treated as VAT-INCLUSIVE'
            : 'amount treated as VAT-EXCLUSIVE',
        };
      });
    },

    async confirm_note(args: Args<'confirm_note'>) {
      return inTenantTx(async (tx) => {
        const updated = await tx
          .update(creditNotes)
          .set({ status: 'confirmed' })
          .where(
            and(
              eq(creditNotes.tenantId, tenantId),
              eq(creditNotes.id, args.note_id),
              eq(creditNotes.status, 'draft'),
            ),
          )
          .returning({ id: creditNotes.id, kind: creditNotes.kind });
        if (updated.length === 0)
          return {
            ok: false as const,
            reason: 'note not found in this business, or already confirmed',
          };
        await appendAudit(tx, tenantId, {
          actor: 'owner',
          action: 'confirm_note',
          detail: { note_id: args.note_id },
        });
        return { ok: true as const, note_id: args.note_id, status: 'confirmed' as const };
      });
    },

    async generate_tds_summary(args: Args<'generate_tds_summary'>) {
      // Sum TDS WITHHELD on CONFIRMED expenses occurring in this BS month. tds_paisa is
      // the amount the business withheld and must deposit (Income Tax Act); it is computed
      // and stored at record time by the deterministic engine — we only total it here.
      const { from, to } = bsMonthRange(args.bs_year, args.bs_month);
      const fromIso = toIso(from);
      const toIsoDate = toIso(to);
      const deadline = tdsDepositDeadline(args.bs_year, args.bs_month);
      return inTenantTx(async (tx) => {
        const [row] = await tx
          .select({
            tds: sql<string>`coalesce(sum(${expenses.tdsPaisa}), 0)`,
            count: sql<number>`count(*) filter (where ${expenses.tdsPaisa} > 0)::int`,
          })
          .from(expenses)
          .where(
            and(
              eq(expenses.tenantId, tenantId),
              eq(expenses.status, 'confirmed'),
              gte(expenses.occurredOn, fromIso),
              lte(expenses.occurredOn, toIsoDate),
            ),
          );
        const tdsPaisa = BigInt(row?.tds ?? '0');
        const withholdingCount = row?.count ?? 0;
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'generate_tds_summary',
          detail: {
            bs_year: args.bs_year,
            bs_month: args.bs_month,
            tds_paisa: n(tdsPaisa),
            withholding_count: withholdingCount,
          },
        });
        return {
          bs_year: args.bs_year,
          bs_month: args.bs_month,
          tds_withheld_paisa: n(tdsPaisa),
          withholding_count: withholdingCount,
          is_nil: tdsPaisa === 0n,
          deposit_deadline_ad: toIso(deadline.ad),
          deposit_deadline_bs: `${deadline.bs.year}-${String(deadline.bs.month).padStart(2, '0')}-${String(deadline.bs.day).padStart(2, '0')}`,
          counts_only: 'confirmed expenses' as const,
          note: 'PREPARED only — the owner deposits TDS via eTDS by the deadline. Verify the live IRD calendar before reminding.',
        };
      });
    },

    async record_opening_balance(args: Args<'record_opening_balance'>) {
      // A receivable/payable opening MUST name a party; a vat_credit opening must NOT.
      if ((args.kind === 'receivable' || args.kind === 'payable') && !args.party_id) {
        return {
          saved: false as const,
          reason: `a ${args.kind} opening balance must name the party_id (the debtor/creditor)`,
        };
      }
      if (args.kind === 'vat_credit' && args.party_id) {
        return {
          saved: false as const,
          reason: 'a vat_credit opening balance must NOT name a party',
        };
      }
      let figures;
      try {
        figures = computeOpening({
          kind: args.kind,
          amountPaisa: BigInt(args.amount_paisa),
          asOf: args.as_of,
        });
      } catch (err) {
        return { saved: false as const, reason: err instanceof Error ? err.message : String(err) };
      }
      const fy = bsFiscalYear(adToBs(toDate(args.as_of)));
      return inTenantTx(async (tx) => {
        // If a party is named, it must exist in THIS tenant (RLS already scopes the read).
        if (args.party_id) {
          const [party] = await tx
            .select({ id: parties.id })
            .from(parties)
            .where(and(eq(parties.tenantId, tenantId), eq(parties.id, args.party_id)));
          if (!party) return { saved: false as const, reason: 'party not found in this business' };
        }
        const [opening] = await tx
          .insert(openingBalances)
          .values({
            tenantId,
            kind: figures.kind,
            partyId: args.party_id ?? null,
            amountPaisa: figures.amountPaisa,
            asOf: figures.asOf,
            fiscalYear: fy,
            note: args.note ?? null,
          })
          .returning({ id: openingBalances.id });
        const openingId = opening!.id;
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'record_opening_balance.draft',
          detail: {
            opening_id: openingId,
            kind: figures.kind,
            amount_paisa: n(figures.amountPaisa),
            party_id: args.party_id ?? null,
            fiscal_year: fy,
          },
        });
        return {
          saved: true as const,
          opening_id: openingId,
          kind: figures.kind,
          status: 'draft' as const,
          amount_paisa: n(figures.amountPaisa),
          as_of: figures.asOf,
          fiscal_year: fy,
          fiscal_year_label: bsFiscalYearLabel(fy),
          ...(args.party_id ? { party_id: args.party_id } : {}),
        };
      });
    },

    async confirm_opening_balance(args: Args<'confirm_opening_balance'>) {
      return inTenantTx(async (tx) => {
        const updated = await tx
          .update(openingBalances)
          .set({ status: 'confirmed' })
          .where(
            and(
              eq(openingBalances.tenantId, tenantId),
              eq(openingBalances.id, args.opening_id),
              eq(openingBalances.status, 'draft'),
            ),
          )
          .returning({ id: openingBalances.id });
        if (updated.length === 0)
          return {
            ok: false as const,
            reason: 'opening balance not found in this business, or already confirmed',
          };
        await appendAudit(tx, tenantId, {
          actor: 'owner',
          action: 'confirm_opening_balance',
          detail: { opening_id: args.opening_id },
        });
        return { ok: true as const, opening_id: args.opening_id, status: 'confirmed' as const };
      });
    },

    async get_annual_summary(args: Args<'get_annual_summary'>) {
      const fy = args.fiscal_year;
      // Gather each of the 12 BS months' confirmed (output VAT, input VAT) from sales/expenses,
      // then let the pure @hisab/shared roll-up carry the credit forward across the year.
      return inTenantTx(async (tx) => {
        // An opening VAT credit (confirmed) from the prior FY seeds the first month.
        const [openRow] = await tx
          .select({ credit: sql<string>`coalesce(sum(${openingBalances.amountPaisa}), 0)` })
          .from(openingBalances)
          .where(
            and(
              eq(openingBalances.tenantId, tenantId),
              eq(openingBalances.kind, 'vat_credit'),
              eq(openingBalances.status, 'confirmed'),
              eq(openingBalances.fiscalYear, fy),
            ),
          );
        const openingCarry = BigInt(openRow?.credit ?? '0');

        const months: MonthlyVat[] = [];
        for (const slot of FISCAL_MONTHS) {
          const calYear = slot.year === 'fy' ? fy : fy + 1;
          const { from, to } = bsMonthRange(calYear, slot.month);
          const fromIso = toIso(from);
          const toIsoDate = toIso(to);
          const [s] = await tx
            .select({ vat: sql<string>`coalesce(sum(${sales.vatPaisa}), 0)` })
            .from(sales)
            .where(
              and(
                eq(sales.tenantId, tenantId),
                eq(sales.status, 'confirmed'),
                gte(sales.occurredOn, fromIso),
                lte(sales.occurredOn, toIsoDate),
              ),
            );
          const [e] = await tx
            .select({ vat: sql<string>`coalesce(sum(${expenses.inputVatPaisa}), 0)` })
            .from(expenses)
            .where(
              and(
                eq(expenses.tenantId, tenantId),
                eq(expenses.status, 'confirmed'),
                gte(expenses.occurredOn, fromIso),
                lte(expenses.occurredOn, toIsoDate),
              ),
            );
          months.push({
            bsMonth: slot.month,
            outputVatPaisa: BigInt(s?.vat ?? '0'),
            inputVatPaisa: BigInt(e?.vat ?? '0'),
          });
        }

        const summary = annualVatSummary(fy, months, openingCarry);
        await appendAudit(tx, tenantId, {
          actor: 'agent',
          action: 'get_annual_summary',
          detail: {
            fiscal_year: fy,
            total_net_payable_paisa: n(summary.totalNetPayablePaisa),
            closing_carry_forward_paisa: n(summary.closingCarryForwardPaisa),
          },
        });
        return {
          fiscal_year: fy,
          fiscal_year_label: bsFiscalYearLabel(fy),
          opening_carry_forward_paisa: n(openingCarry),
          total_output_vat_paisa: n(summary.totalOutputVatPaisa),
          total_input_vat_paisa: n(summary.totalInputVatPaisa),
          total_net_payable_paisa: n(summary.totalNetPayablePaisa),
          closing_carry_forward_paisa: n(summary.closingCarryForwardPaisa),
          months: summary.months.map((m) => ({
            bs_month: m.bsMonth,
            output_vat_paisa: n(m.outputVatPaisa),
            input_vat_paisa: n(m.inputVatPaisa),
            brought_forward_paisa: n(m.broughtForwardPaisa),
            net_payable_paisa: n(m.netPayablePaisa),
            carry_forward_paisa: n(m.carryForwardPaisa),
          })),
          counts_only: 'confirmed entries' as const,
          note: 'PREPARED only — the owner files each monthly return. Carry-forward is intra-year credit per VAT Act Sec 17/24.',
        };
      });
    },
  };
}

// re-export so callers can pass a TaxConfig default if they construct ad hoc.
export { defaultTaxConfig };
