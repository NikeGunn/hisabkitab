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
import { and, eq, sql } from 'drizzle-orm';
import { appendAudit, schema, type Tx } from '@hisab/db';
import {
  adToBs,
  bsFiscalYear,
  bsFiscalYearLabel,
  computeNote,
  defaultTaxConfig,
  splitVatInclusive,
  vatOnExclusive,
  type TaxConfig,
} from '@hisab/shared';
import type { ToolContext } from './tools.js';

const { invoiceSequences, creditNotes, arInvoices } = schema;

// ---------------------------------------------------------------- zod building blocks
const paisa = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('integer paisa (1 NPR = 100 paisa)');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const uuid = z.string().uuid();

export const accountingInputSchemas = {
  next_invoice_number: {
    issued_on: isoDate.describe('the AD issue date; its BS fiscal year selects the series'),
    series: z.enum(['invoice', 'note']).default('invoice').describe('prefix only — both share one gap-free series'),
  },
  issue_note: {
    original_invoice_id: uuid.describe('the CONFIRMED AR invoice this note adjusts'),
    kind: z.enum(['credit', 'debit']).describe('credit = reduce/return; debit = under-bill correction'),
    issued_on: isoDate,
    amount_paisa: paisa.describe('the amount being adjusted, VAT-inclusive unless inclusive=false'),
    inclusive: z.boolean().default(true).describe('amount includes 13% VAT (default true)'),
    reason: z.string().max(500).optional(),
  },
  confirm_note: {
    note_id: uuid,
  },
} as const;

export const accountingToolDescriptions: Record<keyof typeof accountingInputSchemas, string> = {
  next_invoice_number:
    'Allocate the NEXT gap-free sequential VAT invoice/note number for the fiscal year of issued_on (IRD Rule-17). Numbers are never reused or skipped and reset each BS fiscal year. Returns the formatted number (e.g. "2082/83-0007").',
  issue_note:
    'Issue a credit (reduce/return) or debit (under-bill correction) note against a CONFIRMED AR invoice, as a DRAFT. Never edits the original invoice. A credit note cannot exceed the original amounts; VAT is recomputed, never hand-entered. Validation fail → nothing saved.',
  confirm_note: 'Flip a draft credit/debit note to confirmed. Call ONLY after the owner explicitly confirmed.',
};

type Args<K extends keyof typeof accountingInputSchemas> = z.infer<z.ZodObject<(typeof accountingInputSchemas)[K]>>;

const n = (b: bigint): number => Number(b);
const toDate = (iso: string): Date => {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Split a VAT-inclusive/exclusive amount into taxable + VAT (reuses the shared pure fns). */
function splitAmount(amountPaisa: bigint, inclusive: boolean, cfg: TaxConfig): { taxablePaisa: bigint; vatPaisa: bigint } {
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
    .where(and(eq(invoiceSequences.tenantId, tenantId), eq(invoiceSequences.fiscalYear, fiscalYear)))
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
        await appendAudit(tx, tenantId, { actor: 'agent', action: 'next_invoice_number', detail: { fiscal_year: fy, seq, number, series: args.series } });
        return { fiscal_year: fy, fiscal_year_label: bsFiscalYearLabel(fy), sequence: seq, number };
      });
    },

    async issue_note(args: Args<'issue_note'>) {
      const { taxablePaisa, vatPaisa } = splitAmount(BigInt(args.amount_paisa), args.inclusive, cfg);
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
          .where(and(eq(arInvoices.tenantId, tenantId), eq(arInvoices.id, args.original_invoice_id)));
        if (!inv) return { saved: false as const, reason: 'original invoice not found in this business' };
        if (inv.status !== 'confirmed') {
          return { saved: false as const, reason: 'a note can only adjust a CONFIRMED invoice — confirm or edit the draft instead' };
        }

        let figures;
        try {
          figures = computeNote(
            { kind: args.kind, taxablePaisa, vatPaisa },
            { taxablePaisa: inv.taxablePaisa, vatPaisa: inv.vatPaisa, totalPaisa: inv.totalPaisa },
            cfg,
          );
        } catch (err) {
          await appendAudit(tx, tenantId, { actor: 'agent', action: 'issue_note.rejected', detail: { invoice_id: inv.id, reason: err instanceof Error ? err.message : String(err) } });
          return { saved: false as const, reason: err instanceof Error ? err.message : String(err) };
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
        await appendAudit(tx, tenantId, { actor: 'agent', action: 'issue_note.draft', detail: { note_id: noteId, kind: figures.kind, invoice_id: inv.id, total_paisa: n(figures.totalPaisa) } });
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
          assumption: args.inclusive ? 'amount treated as VAT-INCLUSIVE' : 'amount treated as VAT-EXCLUSIVE',
        };
      });
    },

    async confirm_note(args: Args<'confirm_note'>) {
      return inTenantTx(async (tx) => {
        const updated = await tx
          .update(creditNotes)
          .set({ status: 'confirmed' })
          .where(and(eq(creditNotes.tenantId, tenantId), eq(creditNotes.id, args.note_id), eq(creditNotes.status, 'draft')))
          .returning({ id: creditNotes.id, kind: creditNotes.kind });
        if (updated.length === 0) return { ok: false as const, reason: 'note not found in this business, or already confirmed' };
        await appendAudit(tx, tenantId, { actor: 'owner', action: 'confirm_note', detail: { note_id: args.note_id } });
        return { ok: true as const, note_id: args.note_id, status: 'confirmed' as const };
      });
    },
  };
}

// re-export so callers can pass a TaxConfig default if they construct ad hoc.
export { defaultTaxConfig };
