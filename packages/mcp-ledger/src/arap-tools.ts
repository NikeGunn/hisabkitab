/**
 * Module C (PRD v1.2) — AR/AP recording, allocation, analytics & report-data tools.
 * Same discipline as tools.ts: every write is ONE tenant-scoped tx (RLS), validated
 * before save, lands as `draft` until confirm, and appends audit_log + validation_events.
 * Allocation runs in ONE locked transaction (SELECT … FOR UPDATE on the targets) so two
 * concurrent payments can never both decrement the same balance (CLAUDE.md §3 exactly-once).
 *
 * Numbers leave these tools as integer paisa; the agent NEVER hand-writes figures — the
 * report renderer (C-3) consumes the validated objects returned here verbatim.
 */
import { z } from 'zod';
import { and, eq, gte, lte, sql, inArray } from 'drizzle-orm';
import { schema, type Tx } from '@hisab/db';
import {
  bsMonthRange,
  buildAgingReport,
  verifyAgingReport,
  planAutoAllocation,
  planManualAllocation,
  splitVatInclusive,
  validateSale,
  validateExpense,
  vatOnExclusive,
  withIdempotency,
  type AgingRow,
  type AllocationTarget,
  type IdempotentResult,
  type TaxConfig,
} from '@hisab/shared';
import type { ToolContext } from './tools.js';
import { txIdempotencyStore } from './idempotency-store.js';

const { parties, arInvoices, apBills, partyPayments, paymentAllocations } = schema;

// ---------------------------------------------------------------- zod building blocks
const paisa = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('integer paisa (1 NPR = 100 paisa)');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const bsYear = z.number().int().min(2000).max(2200);
const bsMonth = z.number().int().min(1).max(12);
const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('optional exactly-once key: a retry with the same key returns the original result, never a duplicate entry');

export const arapInputSchemas = {
  upsert_party: {
    name: z.string().min(1).max(200),
    pan_vat_no: z.string().max(50).optional(),
    is_vat_registered: z.boolean().optional(),
    kind: z.enum(['customer', 'supplier', 'both']).optional(),
    phone: z.string().max(30).optional(),
  },
  record_credit_sale: {
    party: z.string().min(1).max(200),
    invoice_no: z.string().max(100).optional(),
    issued_on: isoDate,
    due_on: isoDate.optional().describe('expected receipt date; omit if none — never guess one'),
    amount_paisa: paisa,
    inclusive: z.boolean().default(true).describe('amount includes 13% VAT (default true)'),
    idempotency_key: idempotencyKey,
  },
  record_credit_purchase: {
    party: z.string().min(1).max(200),
    bill_no: z.string().max(100).optional(),
    billed_on: isoDate,
    due_on: isoDate.optional(),
    amount_paisa: paisa,
    inclusive: z.boolean().default(true),
    vendor_is_vat_registered: z.boolean().describe('ask the owner if unknown — do not guess'),
    invoice_type: z.enum(['rule17', 'rule17ka', 'other']).optional(),
    for_taxable_business_use: z.boolean().describe('required for input-credit eligibility'),
    idempotency_key: idempotencyKey,
  },
  record_party_payment: {
    party: z.string().min(1).max(200),
    direction: z.enum(['received', 'paid']),
    amount_paisa: paisa,
    paid_on: isoDate,
    method: z.enum(['cash', 'khalti', 'esewa', 'bank']).optional(),
    allocate: z
      .array(z.object({ target_id: uuid, amount_paisa: paisa }))
      .optional()
      .describe('explicit allocations; omit to auto-apply oldest-first across open invoices/bills'),
    idempotency_key: idempotencyKey,
  },
  confirm_arap_entry: {
    entry_type: z.enum(['ar_invoice', 'ap_bill', 'party_payment']),
    entry_id: uuid,
  },
  // ---- analytics (read-only, parameterized, tenant-scoped) ----
  get_receivables_summary: { as_of: isoDate.optional() },
  get_payables_summary: { as_of: isoDate.optional() },
  get_statement: { party: z.string().min(1).max(200), from: isoDate.optional(), to: isoDate.optional() },
  get_sales_summary: { bs_year: bsYear, bs_month: bsMonth },
  get_top_parties: {
    metric: z.enum(['receivable', 'payable']),
    n: z.number().int().min(1).max(50).default(5),
  },
  request_report: {
    report_type: z.enum(['receivables', 'payables', 'statement', 'sales_summary']),
    party: z.string().min(1).max(200).optional().describe('required for a statement'),
    as_of: isoDate.optional(),
    bs_year: bsYear.optional().describe('required for sales_summary'),
    bs_month: bsMonth.optional().describe('required for sales_summary'),
  },
} as const;

export const arapToolDescriptions: Record<keyof typeof arapInputSchemas, string> = {
  upsert_party:
    'Remember a customer/supplier (party) by name with PAN + VAT status, so the owner is not re-asked. kind = customer | supplier | both.',
  record_credit_sale:
    'Record a credit sale (invoice issued, AR) as a DRAFT. balance = total until payments allocate against it. Amount is VAT-inclusive unless inclusive=false. Validation fail → nothing saved.',
  record_credit_purchase:
    'Record a credit purchase (bill received, AP) as a DRAFT with input-VAT-credit eligibility per v1.1 rules. Validation fail → nothing saved.',
  record_party_payment:
    'Record a payment received (AR) or paid (AP) as a DRAFT and allocate it to open invoices/bills. Omit `allocate` to auto-apply oldest-first. Over-payment beyond the open balance is rejected — confirm it is an advance. Allocation + balance decrement run in ONE locked transaction on confirm.',
  confirm_arap_entry:
    'Flip a draft AR invoice / AP bill / party payment to confirmed. For a payment this ATOMICALLY applies its allocations and decrements balances. Call ONLY after the owner explicitly confirmed.',
  get_receivables_summary:
    'Debtors/receivables: confirmed open AR invoices with balance, days overdue, and aging buckets (current/1-30/31-60/61-90/90+). Verified to reconcile (buckets sum to total). Numbers for the agent to read, never invent.',
  get_payables_summary: 'Creditors/payables: symmetric to get_receivables_summary for confirmed open AP bills.',
  get_statement:
    'Statement of account for one party: every confirmed invoice/bill and payment in date order with a running balance and closing balance.',
  get_sales_summary: 'Sales summary for a BS month from CONFIRMED sales: gross, VAT, net, count.',
  get_top_parties: 'Top N parties by outstanding receivable or payable balance (confirmed, open).',
  request_report:
    'Request a professional PDF report (debtors/creditors/statement/sales). Acknowledge to the owner that it is being prepared; the backend validates, renders, reconciles, and sends the PDF as a WhatsApp document within a couple of minutes. Use the EXACT figures from the analytics tools in your acknowledgement, or state none. statement needs `party`; sales_summary needs bs_year + bs_month.',
};

// ---------------------------------------------------------------- helpers (DRY)
const n = (b: bigint): number => Number(b);
const toDate = (iso: string): Date => {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const toIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function splitAmount(amountPaisa: bigint, inclusive: boolean, vatApplies: boolean, cfg: TaxConfig) {
  if (!vatApplies) return { exclPaisa: amountPaisa, vatPaisa: 0n };
  if (inclusive) return splitVatInclusive(amountPaisa, cfg);
  return { exclPaisa: amountPaisa, vatPaisa: vatOnExclusive(amountPaisa, cfg) };
}

/** Find or create the party row by case-insensitive name, inside the current tx. */
async function resolveParty(
  tx: Tx,
  tenantId: string,
  name: string,
  kind: 'customer' | 'supplier' | 'both',
): Promise<string> {
  const [existing] = await tx
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), sql`lower(${parties.name}) = lower(${name})`));
  if (existing) return existing.id;
  const [row] = await tx
    .insert(parties)
    .values({ tenantId, name, kind })
    .returning({ id: parties.id });
  return row!.id;
}

async function appendAudit(tx: Tx, tenantId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await tx.insert(schema.auditLog).values({ tenantId, actor: 'agent', action, detail });
}

async function appendValidationFails(
  tx: Tx,
  tenantId: string,
  entryType: string,
  entryId: string | null,
  report: { results: Array<{ check: string; result: string; reason: string }> },
): Promise<void> {
  const events = report.results
    .filter((r) => r.result !== 'pass')
    .map((r) => ({
      tenantId,
      entryType,
      entryId,
      result: r.result as 'warn' | 'fail',
      reason: `${r.check}: ${r.reason}`,
    }));
  if (events.length > 0) await tx.insert(schema.validationEvents).values(events);
}

type Args<K extends keyof typeof arapInputSchemas> = z.infer<z.ZodObject<(typeof arapInputSchemas)[K]>>;

export function createArapToolHandlers(ctx: ToolContext) {
  const { db, tenantId, cfg } = ctx;
  const inTenantTx = <T>(fn: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });

  /** Entry-creating body in ONE tenant tx, deduped by `key` (P9, see tools.ts idemTx). */
  const idemTx = <T extends IdempotentResult>(scope: string, key: string | undefined, body: (tx: Tx) => Promise<T>) =>
    inTenantTx((tx) => withIdempotency(txIdempotencyStore(tx, tenantId), key, scope, () => body(tx)));

  return {
    async upsert_party(args: Args<'upsert_party'>) {
      return inTenantTx(async (tx) => {
        const [row] = await tx
          .insert(parties)
          .values({
            tenantId,
            name: args.name,
            panVatNo: args.pan_vat_no ?? null,
            isVatRegistered: args.is_vat_registered ?? null,
            kind: args.kind ?? 'both',
            phone: args.phone ?? null,
          })
          .onConflictDoUpdate({
            target: [parties.tenantId, parties.name],
            set: {
              ...(args.pan_vat_no !== undefined ? { panVatNo: args.pan_vat_no } : {}),
              ...(args.is_vat_registered !== undefined ? { isVatRegistered: args.is_vat_registered } : {}),
              ...(args.kind !== undefined ? { kind: args.kind } : {}),
              ...(args.phone !== undefined ? { phone: args.phone } : {}),
            },
          })
          .returning();
        await appendAudit(tx, tenantId, 'upsert_party', { name: args.name });
        const p = row!;
        return { party_id: p.id, name: p.name, kind: p.kind, pan_vat_no: p.panVatNo, is_vat_registered: p.isVatRegistered };
      });
    },

    async record_credit_sale(args: Args<'record_credit_sale'>) {
      const { exclPaisa, vatPaisa } = splitAmount(BigInt(args.amount_paisa), args.inclusive, true, cfg);
      const totalPaisa = exclPaisa + vatPaisa;
      return idemTx('record_credit_sale', args.idempotency_key, async (tx) => {
        const report = validateSale(
          { occurredOn: toDate(args.issued_on), taxablePaisa: exclPaisa, vatPaisa, totalPaisa },
          { asOf: new Date(), existing: [], cfg },
        );
        if (report.overall === 'fail') {
          await appendAudit(tx, tenantId, 'record_credit_sale.rejected', { args });
          await appendValidationFails(tx, tenantId, 'ar_invoice', null, report);
          return { saved: false as const, reason: 'validation failed — never saved', validation: report.results };
        }
        const partyId = await resolveParty(tx, tenantId, args.party, 'customer');
        const [row] = await tx
          .insert(arInvoices)
          .values({
            tenantId,
            partyId,
            invoiceNo: args.invoice_no ?? null,
            issuedOn: args.issued_on,
            dueOn: args.due_on ?? null,
            taxablePaisa: exclPaisa,
            vatPaisa,
            totalPaisa,
            balancePaisa: totalPaisa,
          })
          .returning({ id: arInvoices.id });
        const invoiceId = row!.id;
        await appendAudit(tx, tenantId, 'record_credit_sale.draft', { invoice_id: invoiceId, party: args.party, total_paisa: n(totalPaisa) });
        await appendValidationFails(tx, tenantId, 'ar_invoice', invoiceId, report);
        return {
          saved: true as const,
          invoice_id: invoiceId,
          party_id: partyId,
          status: 'draft' as const,
          taxable_paisa: n(exclPaisa),
          vat_paisa: n(vatPaisa),
          total_paisa: n(totalPaisa),
          balance_paisa: n(totalPaisa),
          ...(args.due_on ? { due_on: args.due_on } : { due_on: null }),
          assumption: args.inclusive ? 'amount treated as VAT-INCLUSIVE' : 'amount treated as VAT-EXCLUSIVE',
          validation: report.results,
        };
      });
    },

    async record_credit_purchase(args: Args<'record_credit_purchase'>) {
      const { exclPaisa, vatPaisa } = splitAmount(BigInt(args.amount_paisa), args.inclusive, args.vendor_is_vat_registered, cfg);
      const totalPaisa = exclPaisa + vatPaisa;
      return idemTx('record_credit_purchase', args.idempotency_key, async (tx) => {
        const report = validateExpense(
          {
            vendorVatRegistered: args.vendor_is_vat_registered,
            invoiceDate: toDate(args.billed_on),
            taxablePaisa: exclPaisa,
            vatPaisa,
            totalPaisa,
            forTaxableBusinessUse: args.for_taxable_business_use,
            vendorName: args.party,
            ...(args.invoice_type !== undefined ? { invoiceType: args.invoice_type } : {}),
            ...(args.bill_no !== undefined ? { invoiceNo: args.bill_no } : {}),
          },
          { asOf: new Date(), existing: [], cfg },
        );
        if (report.overall === 'fail') {
          await appendAudit(tx, tenantId, 'record_credit_purchase.rejected', { args });
          await appendValidationFails(tx, tenantId, 'ap_bill', null, report);
          return { saved: false as const, reason: 'validation failed — never saved', validation: report.results };
        }
        const partyId = await resolveParty(tx, tenantId, args.party, 'supplier');
        const [row] = await tx
          .insert(apBills)
          .values({
            tenantId,
            partyId,
            billNo: args.bill_no ?? null,
            billedOn: args.billed_on,
            dueOn: args.due_on ?? null,
            taxablePaisa: exclPaisa,
            vatPaisa,
            totalPaisa,
            balancePaisa: totalPaisa,
            inputCreditEligible: report.inputCreditEligible,
          })
          .returning({ id: apBills.id });
        const billId = row!.id;
        await appendAudit(tx, tenantId, 'record_credit_purchase.draft', { bill_id: billId, party: args.party, total_paisa: n(totalPaisa) });
        await appendValidationFails(tx, tenantId, 'ap_bill', billId, report);
        return {
          saved: true as const,
          bill_id: billId,
          party_id: partyId,
          status: 'draft' as const,
          taxable_paisa: n(exclPaisa),
          vat_paisa: n(vatPaisa),
          total_paisa: n(totalPaisa),
          balance_paisa: n(totalPaisa),
          input_credit_eligible: report.inputCreditEligible,
          input_credit_reasons: report.inputCreditReasons,
          ...(args.due_on ? { due_on: args.due_on } : { due_on: null }),
          assumption: args.inclusive ? 'amount treated as VAT-INCLUSIVE' : 'amount treated as VAT-EXCLUSIVE',
          validation: report.results,
        };
      });
    },

    /**
     * Record the payment row as a draft and stage its allocation plan WITHOUT yet
     * touching balances (balances move only on confirm, in one locked tx). The plan
     * is computed now so the agent can echo "this clears invoices X, Y" before the owner OKs.
     */
    async record_party_payment(args: Args<'record_party_payment'>) {
      const amount = BigInt(args.amount_paisa);
      const targetTable = args.direction === 'received' ? arInvoices : apBills;
      const targetType = args.direction === 'received' ? ('ar_invoice' as const) : ('ap_bill' as const);
      return idemTx('record_party_payment', args.idempotency_key, async (tx) => {
        const partyId = await resolveParty(tx, tenantId, args.party, args.direction === 'received' ? 'customer' : 'supplier');
        const openRows = await tx
          .select()
          .from(targetTable)
          .where(
            and(
              eq(targetTable.tenantId, tenantId),
              eq(targetTable.partyId, partyId),
              eq(targetTable.status, 'confirmed'),
              sql`${targetTable.balancePaisa} > 0`,
            ),
          );
        const targets: AllocationTarget[] = openRows.map((r) => ({
          id: r.id,
          datedOn: toDate('issuedOn' in r ? r.issuedOn : r.billedOn),
          balancePaisa: r.balancePaisa,
        }));

        let plan;
        try {
          plan =
            args.allocate && args.allocate.length > 0
              ? planManualAllocation(amount, args.allocate.map((a) => ({ targetId: a.target_id, amountPaisa: BigInt(a.amount_paisa) })), targets)
              : planAutoAllocation(amount, targets);
        } catch (err) {
          await appendAudit(tx, tenantId, 'record_party_payment.rejected', { party: args.party, reason: err instanceof Error ? err.message : String(err) });
          return { saved: false as const, reason: err instanceof Error ? err.message : String(err) };
        }

        const [pay] = await tx
          .insert(partyPayments)
          .values({
            tenantId,
            partyId,
            direction: args.direction,
            amountPaisa: amount,
            paidOn: args.paid_on,
            method: args.method ?? null,
          })
          .returning({ id: partyPayments.id });
        const paymentId = pay!.id;
        // Stage the allocation lines now; they are applied (balances decremented) on confirm.
        await tx.insert(paymentAllocations).values(
          plan.lines.map((l) => ({ tenantId, paymentId, targetType, targetId: l.targetId, amountPaisa: l.amountPaisa })),
        );
        await appendAudit(tx, tenantId, 'record_party_payment.draft', { payment_id: paymentId, party: args.party, amount_paisa: n(amount), lines: plan.lines.length });
        return {
          saved: true as const,
          payment_id: paymentId,
          party_id: partyId,
          status: 'draft' as const,
          direction: args.direction,
          amount_paisa: n(amount),
          allocations: plan.lines.map((l) => ({ target_id: l.targetId, amount_paisa: n(l.amountPaisa), new_balance_paisa: n(l.newBalancePaisa) })),
        };
      });
    },

    async confirm_arap_entry(args: Args<'confirm_arap_entry'>) {
      return inTenantTx(async (tx) => {
        if (args.entry_type === 'party_payment') {
          return confirmPayment(tx, tenantId, args.entry_id);
        }
        const table = args.entry_type === 'ar_invoice' ? arInvoices : apBills;
        const updated = await tx
          .update(table)
          .set({ status: 'confirmed' })
          .where(and(eq(table.id, args.entry_id), eq(table.status, 'draft')))
          .returning({ id: table.id });
        if (updated.length === 0) return { ok: false as const, reason: 'entry not found in this business, or already confirmed' };
        await tx.insert(schema.auditLog).values({ tenantId, actor: 'owner', action: 'confirm_arap_entry', detail: { entry_type: args.entry_type, entry_id: args.entry_id } });
        return { ok: true as const, entry_id: args.entry_id, status: 'confirmed' as const };
      });
    },

    // ---------------------------------------------------------------- analytics
    async get_receivables_summary(args: Args<'get_receivables_summary'>) {
      return inTenantTx((tx) => receivablesOrPayables(tx, ctx, 'ar', args.as_of));
    },
    async get_payables_summary(args: Args<'get_payables_summary'>) {
      return inTenantTx((tx) => receivablesOrPayables(tx, ctx, 'ap', args.as_of));
    },

    async get_statement(args: Args<'get_statement'>) {
      return inTenantTx(async (tx) => {
        const [party] = await tx
          .select()
          .from(parties)
          .where(and(eq(parties.tenantId, tenantId), sql`lower(${parties.name}) = lower(${args.party})`));
        if (!party) return { found: false as const, reason: 'no such party in this business' };

        const fromIso = args.from ?? '0001-01-01';
        const toIsoBound = args.to ?? '9999-12-31';
        const [invs, bills, pays] = await Promise.all([
          tx.select().from(arInvoices).where(and(eq(arInvoices.tenantId, tenantId), eq(arInvoices.partyId, party.id), eq(arInvoices.status, 'confirmed'), gte(arInvoices.issuedOn, fromIso), lte(arInvoices.issuedOn, toIsoBound))),
          tx.select().from(apBills).where(and(eq(apBills.tenantId, tenantId), eq(apBills.partyId, party.id), eq(apBills.status, 'confirmed'), gte(apBills.billedOn, fromIso), lte(apBills.billedOn, toIsoBound))),
          tx.select().from(partyPayments).where(and(eq(partyPayments.tenantId, tenantId), eq(partyPayments.partyId, party.id), eq(partyPayments.status, 'confirmed'), gte(partyPayments.paidOn, fromIso), lte(partyPayments.paidOn, toIsoBound))),
        ]);

        // Positive line = party owes us (AR invoice / AP payment we made); negative = we owe / they paid us.
        type Line = { date: string; kind: string; ref: string | null; debit: bigint; credit: bigint };
        const lines: Line[] = [
          ...invs.map((r) => ({ date: r.issuedOn, kind: 'invoice', ref: r.invoiceNo, debit: r.totalPaisa, credit: 0n })),
          ...bills.map((r) => ({ date: r.billedOn, kind: 'bill', ref: r.billNo, debit: 0n, credit: r.totalPaisa })),
          ...pays.map((r) => ({ date: r.paidOn, kind: r.direction === 'received' ? 'payment received' : 'payment made', ref: null, debit: r.direction === 'paid' ? r.amountPaisa : 0n, credit: r.direction === 'received' ? r.amountPaisa : 0n })),
        ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

        let running = 0n;
        const out = lines.map((l) => {
          running += l.debit - l.credit;
          return { date: l.date, kind: l.kind, ref: l.ref, debit_paisa: n(l.debit), credit_paisa: n(l.credit), running_balance_paisa: n(running) };
        });
        return { found: true as const, party: party.name, lines: out, closing_balance_paisa: n(running), line_count: out.length };
      });
    },

    async get_sales_summary(args: Args<'get_sales_summary'>) {
      const { from, to } = bsMonthRange(args.bs_year, args.bs_month);
      const fromIso = toIso(from);
      const toIsoBound = toIso(to);
      return inTenantTx(async (tx) => {
        const [row] = await tx
          .select({
            gross: sql<string>`coalesce(sum(${schema.sales.amountExclVatPaisa}), 0)`,
            vat: sql<string>`coalesce(sum(${schema.sales.vatPaisa}), 0)`,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.sales)
          .where(and(eq(schema.sales.tenantId, tenantId), eq(schema.sales.status, 'confirmed'), gte(schema.sales.occurredOn, fromIso), lte(schema.sales.occurredOn, toIsoBound)));
        const net = BigInt(row?.gross ?? '0');
        const vat = BigInt(row?.vat ?? '0');
        return { bs_year: args.bs_year, bs_month: args.bs_month, net_paisa: n(net), vat_paisa: n(vat), gross_paisa: n(net + vat), count: row?.count ?? 0, basis: 'confirmed sales' as const };
      });
    },

    /**
     * Validate a report request and return a marker the orchestrator detects to run
     * the deterministic render+reconcile+deliver job (PDF deps live in the orchestrator,
     * not the MCP). This tool does NOT render — it confirms the parameters are complete.
     */
    async request_report(args: Args<'request_report'>) {
      if (args.report_type === 'statement' && !args.party) {
        return { accepted: false as const, reason: 'a statement needs the party name — ask the owner which customer/supplier' };
      }
      if (args.report_type === 'sales_summary' && (args.bs_year === undefined || args.bs_month === undefined)) {
        return { accepted: false as const, reason: 'a sales summary needs the BS year and month' };
      }
      await inTenantTx((tx) => appendAudit(tx, tenantId, 'request_report', { ...args }));
      return {
        accepted: true as const,
        // The orchestrator scans tool results for this marker to dispatch the report job.
        report_request: {
          report_type: args.report_type,
          ...(args.party ? { party: args.party } : {}),
          ...(args.as_of ? { as_of: args.as_of } : {}),
          ...(args.bs_year !== undefined ? { bs_year: args.bs_year } : {}),
          ...(args.bs_month !== undefined ? { bs_month: args.bs_month } : {}),
        },
        note: 'Acknowledge to the owner that the PDF is being prepared and will arrive shortly.',
      };
    },

    async get_top_parties(args: Args<'get_top_parties'>) {
      const table = args.metric === 'receivable' ? arInvoices : apBills;
      return inTenantTx(async (tx) => {
        const rows = await tx
          .select({ partyId: table.partyId, name: parties.name, balance: sql<string>`sum(${table.balancePaisa})` })
          .from(table)
          .innerJoin(parties, eq(parties.id, table.partyId))
          .where(and(eq(table.tenantId, tenantId), eq(table.status, 'confirmed'), sql`${table.balancePaisa} > 0`))
          .groupBy(table.partyId, parties.name)
          .orderBy(sql`sum(${table.balancePaisa}) desc`)
          .limit(args.n);
        return { metric: args.metric, rows: rows.map((r) => ({ party_id: r.partyId, party: r.name, balance_paisa: n(BigInt(r.balance)) })) };
      });
    },
  };
}

/**
 * Confirm a payment: lock its open targets FOR UPDATE, re-validate the staged
 * allocation against CURRENT balances (a target may have moved since draft), decrement
 * balances, flip statuses — all in the caller's single tx. This is the exactly-once core.
 */
async function confirmPayment(tx: Tx, tenantId: string, paymentId: string) {
  const [pay] = await tx
    .select()
    .from(partyPayments)
    .where(and(eq(partyPayments.tenantId, tenantId), eq(partyPayments.id, paymentId), eq(partyPayments.status, 'draft')));
  if (!pay) return { ok: false as const, reason: 'payment not found in this business, or already confirmed' };

  const allocs = await tx
    .select()
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.tenantId, tenantId), eq(paymentAllocations.paymentId, paymentId)));

  const targetTable = pay.direction === 'received' ? arInvoices : apBills;
  const targetIds = allocs.map((a) => a.targetId);
  if (targetIds.length > 0) {
    // Lock the target rows so a concurrent confirm cannot double-spend the same balance.
    const locked = await tx
      .select()
      .from(targetTable)
      .where(and(eq(targetTable.tenantId, tenantId), inArray(targetTable.id, targetIds)))
      .for('update');
    const balById = new Map(locked.map((r) => [r.id, r.balancePaisa]));
    for (const a of allocs) {
      const bal = balById.get(a.targetId);
      if (bal === undefined) return { ok: false as const, reason: `allocation target ${a.targetId} no longer exists — re-record the payment` };
      if (a.amountPaisa > bal) {
        return { ok: false as const, reason: `allocation ${a.amountPaisa} now exceeds the target's balance ${bal} (it changed since this was drafted) — re-record the payment` };
      }
    }
    for (const a of allocs) {
      await tx
        .update(targetTable)
        .set({ balancePaisa: sql`${targetTable.balancePaisa} - ${a.amountPaisa}` })
        .where(and(eq(targetTable.tenantId, tenantId), eq(targetTable.id, a.targetId)));
    }
  }

  await tx.update(partyPayments).set({ status: 'confirmed' }).where(eq(partyPayments.id, paymentId));
  await tx.insert(schema.auditLog).values({ tenantId, actor: 'owner', action: 'confirm_party_payment', detail: { payment_id: paymentId, allocations: allocs.length } });
  return { ok: true as const, entry_id: paymentId, status: 'confirmed' as const, allocations_applied: allocs.length };
}

/** Shared receivables/payables aging summary (DRY across AR & AP). */
async function receivablesOrPayables(tx: Tx, ctx: ToolContext, side: 'ar' | 'ap', asOfIso?: string) {
  const { tenantId } = ctx;
  const asOf = asOfIso ? toDate(asOfIso) : new Date();
  const table = side === 'ar' ? arInvoices : apBills;
  const rows = await tx
    .select({
      id: table.id,
      partyName: parties.name,
      invoiceNo: side === 'ar' ? arInvoices.invoiceNo : apBills.billNo,
      datedOn: side === 'ar' ? arInvoices.issuedOn : apBills.billedOn,
      dueOn: table.dueOn,
      totalPaisa: table.totalPaisa,
      balancePaisa: table.balancePaisa,
    })
    .from(table)
    .innerJoin(parties, eq(parties.id, table.partyId))
    .where(and(eq(table.tenantId, tenantId), eq(table.status, 'confirmed'), sql`${table.balancePaisa} > 0`));

  const agingRows: AgingRow[] = rows.map((r) => ({ balancePaisa: r.balancePaisa, dueOn: r.dueOn ? toDate(r.dueOn) : null, partyName: r.partyName }));
  const aging = buildAgingReport(agingRows, asOf);
  // Independent re-verification: a tampered/incoherent aging is FAILED, never returned as truth.
  const verdict = verifyAgingReport(aging, agingRows, asOf);

  return {
    as_of: toIso(asOf),
    reconciled: verdict.result === 'pass',
    ...(verdict.result !== 'pass' ? { reconcile_reasons: verdict.reasons } : {}),
    rows: rows.map((r) => {
      const days = r.dueOn ? Math.floor((Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate()) - Date.UTC(toDate(r.dueOn).getFullYear(), toDate(r.dueOn).getMonth(), toDate(r.dueOn).getDate())) / 86_400_000) : null;
      return {
        party: r.partyName,
        ref: r.invoiceNo,
        dated_on: r.datedOn,
        due_on: r.dueOn,
        total_paisa: Number(r.totalPaisa),
        paid_paisa: Number(r.totalPaisa - r.balancePaisa),
        balance_paisa: Number(r.balancePaisa),
        days_overdue: days !== null && days > 0 ? days : 0,
      };
    }),
    aging: {
      current_paisa: Number(aging.buckets.current),
      days1to30_paisa: Number(aging.buckets.days1to30),
      days31to60_paisa: Number(aging.buckets.days31to60),
      days61to90_paisa: Number(aging.buckets.days61to90),
      days90plus_paisa: Number(aging.buckets.days90plus),
      no_due_date_paisa: Number(aging.buckets.noDueDate),
    },
    total_paisa: Number(aging.totalPaisa),
  };
}
