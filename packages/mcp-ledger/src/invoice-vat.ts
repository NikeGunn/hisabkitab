/**
 * Invoice VAT resolution for the entry-creating tools (record_sale / record_expense /
 * record_credit_sale / record_credit_purchase). ONE place that maps the tool args to
 * `resolveInvoiceVat`, so every path stores the same thing: the bill's own printed
 * taxable + VAT when given, else the 13% invoice-level split.
 * Per-line-rounded bills drift 1–6 paisa when re-derived from the total.
 */
import { z } from 'zod';
import { resolveInvoiceVat, type InvoiceVat, type TaxConfig } from '@hisab/shared';

const printedPaisa = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Optional printed-figure fields, spread into each entry tool's input schema. */
export const printedVatFields = {
  printed_taxable_paisa: printedPaisa
    .optional()
    .describe(
      "the taxable amount EXACTLY as printed on the bill/invoice. Pass it WITH printed_vat_paisa whenever the bill shows both and you read them with high confidence — they are stored as the invoice says (never re-derived). Omit if the bill doesn't show them",
    ),
  printed_vat_paisa: printedPaisa
    .optional()
    .describe(
      'the VAT amount EXACTLY as printed on the bill/invoice; always together with printed_taxable_paisa',
    ),
};

export interface PrintedVatArgs {
  printed_taxable_paisa?: number | undefined;
  printed_vat_paisa?: number | undefined;
}

/** Resolve what to store. Only one printed field given → refused (never half-trusted). */
export function resolveEntryVat(
  args: PrintedVatArgs & { amount_paisa: number; inclusive: boolean },
  vatApplies: boolean,
  cfg: TaxConfig,
): InvoiceVat {
  const t = args.printed_taxable_paisa;
  const v = args.printed_vat_paisa;
  if ((t === undefined) !== (v === undefined)) {
    return {
      ok: false,
      reason: 'pass BOTH printed_taxable_paisa and printed_vat_paisa from the bill, or neither',
    };
  }
  return resolveInvoiceVat(
    {
      amountPaisa: BigInt(args.amount_paisa),
      inclusive: args.inclusive,
      vatApplies,
      printed:
        t !== undefined && v !== undefined
          ? { taxablePaisa: BigInt(t), vatPaisa: BigInt(v) }
          : undefined,
    },
    cfg,
  );
}

/** Owner-facing transparency fields returned by every entry tool. */
export function vatSourceFields(r: Extract<InvoiceVat, { ok: true }>) {
  const diff = r.vatPaisa - r.computedVatPaisa;
  return {
    vat_source:
      r.source === 'printed'
        ? ('as printed on the invoice' as const)
        : ('computed at 13%' as const),
    ...(r.source === 'printed' && diff !== 0n ? { printed_vat_vs_13pct_paisa: Number(diff) } : {}),
  };
}
