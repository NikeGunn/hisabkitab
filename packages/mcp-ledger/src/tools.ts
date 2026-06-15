/**
 * Ledger MCP tools (PRD v1.0 §9 + v1.1 §9). Every write:
 *   - runs inside ONE tenant-scoped transaction (RLS via signed session metadata),
 *   - is validated by the shared Validation Engine BEFORE saving (`fail` → never saved),
 *   - lands as `draft` until confirm_entry, and
 *   - appends audit_log + validation_events rows.
 * Amounts cross the wire as integer paisa numbers (≤ MAX_SAFE_INTEGER, enforced).
 */
import { z } from 'zod';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { schema, withTenant, type Db, type Tx } from '@hisab/db';
import {
  bsMonthRange,
  computeTds,
  splitVatInclusive,
  validateExpense,
  validateSale,
  vatFilingDeadline,
  vatOnExclusive,
  netVatPosition,
  withIdempotency,
  type CheckOutcome,
  type ExistingEntryRef,
  type ExpenseCandidate,
  type IdempotentResult,
  type TaxConfig,
  type ValidationReport,
} from '@hisab/shared';
import { arapInputSchemas, arapToolDescriptions, createArapToolHandlers } from './arap-tools.js';
import { txIdempotencyStore } from './idempotency-store.js';

const { sales, expenses, vendors, vatReturns, auditLog, validationEvents } = schema;

// ---------------------------------------------------------------- zod building blocks

const paisa = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('integer paisa (1 NPR = 100 paisa)');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const bsYear = z.number().int().min(2000).max(2200);
const bsMonth = z.number().int().min(1).max(12);
const uuid = z.string().uuid();

/**
 * Optional client-supplied exactly-once key (P9, PRD v2.0 §6). When the same call
 * is retried with the same key, the ORIGINAL result is returned and no second row
 * is written. Shared by every entry-creating tool.
 */
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('optional exactly-once key: a retry with the same key returns the original result, never a duplicate entry');

export const inputSchemas = {
  compute_vat: {
    amount_paisa: paisa,
    inclusive: z.boolean().default(true),
  },
  record_sale: {
    occurred_on: isoDate,
    description: z.string().max(500).optional(),
    amount_paisa: paisa,
    inclusive: z.boolean().default(true).describe('amount includes 13% VAT (default true)'),
    payment_method: z.enum(['cash', 'esewa', 'khalti', 'bank']).optional(),
    idempotency_key: idempotencyKey,
  },
  record_expense: {
    occurred_on: isoDate,
    vendor_name: z.string().max(200).optional(),
    vendor_is_vat_registered: z.boolean().describe('ask the owner if unknown — do not guess'),
    invoice_no: z.string().max(100).optional(),
    invoice_type: z.enum(['rule17', 'rule17ka', 'other']).optional(),
    category: z.string().max(100).optional(),
    amount_paisa: paisa,
    inclusive: z.boolean().default(true),
    is_service: z.boolean().describe('service payments may attract TDS'),
    for_taxable_business_use: z.boolean().describe('required for input-credit eligibility'),
    receipt_file_id: z.string().max(200).optional(),
    extraction: z.record(z.string(), z.unknown()).optional().describe('per-field {value, confidence}'),
    idempotency_key: idempotencyKey,
  },
  validate_entry: {
    entry_type: z.enum(['sale', 'expense']),
    occurred_on: isoDate.optional(),
    vendor_name: z.string().max(200).optional(),
    vendor_is_vat_registered: z.boolean().optional(),
    invoice_no: z.string().max(100).optional(),
    invoice_type: z.enum(['rule17', 'rule17ka', 'other']).optional(),
    taxable_paisa: paisa.optional(),
    vat_paisa: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    total_paisa: paisa.optional(),
    for_taxable_business_use: z.boolean().optional(),
  },
  confirm_entry: {
    entry_type: z.enum(['sale', 'expense']),
    entry_id: uuid,
  },
  generate_return_summary: { bs_year: bsYear, bs_month: bsMonth },
  list_transactions: {
    bs_year: bsYear,
    bs_month: bsMonth,
    type: z.enum(['sale', 'expense']).optional(),
    status: z.enum(['draft', 'confirmed']).optional(),
  },
  mark_return_filed_by_user: { return_id: uuid },
  upsert_vendor: {
    name: z.string().min(1).max(200),
    pan_vat_no: z.string().max(50).optional(),
    is_vat_registered: z.boolean().optional(),
  },
  get_vendor: { name: z.string().min(1).max(200) },
  ...arapInputSchemas,
} as const;

// ---------------------------------------------------------------- shared helpers (DRY)

export interface ToolContext {
  db: Db;
  tenantId: string;
  cfg: TaxConfig;
}

const n = (b: bigint): number => Number(b); // amounts are capped ≪ 2^53
const toDate = (iso: string): Date => {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const toIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function serializeValidation(report: ValidationReport) {
  return {
    overall: report.overall,
    checks: report.results.map(({ check, result, reason }) => ({ check, result, reason })),
    input_credit_eligible: report.inputCreditEligible,
    input_credit_reasons: report.inputCreditReasons,
  };
}

/** Append audit_log + every non-pass validation result, in the SAME transaction as the write. */
async function logWrite(
  tx: Tx,
  ctx: ToolContext,
  action: string,
  detail: Record<string, unknown>,
  validation?: { report: ValidationReport; entryType: string; entryId: string | null },
): Promise<void> {
  await tx.insert(auditLog).values({ tenantId: ctx.tenantId, actor: 'agent', action, detail });
  if (validation) {
    const events = validation.report.results
      .filter((r) => r.result !== 'pass')
      .map((r) => ({
        tenantId: ctx.tenantId,
        entryType: validation.entryType,
        entryId: validation.entryId,
        result: r.result as CheckOutcome,
        reason: `${r.check}: ${r.reason}`,
      }));
    if (events.length > 0) await tx.insert(validationEvents).values(events);
  }
}

/** Existing entries that could collide with a candidate — both duplicate axes, indexed. */
async function findDuplicateCandidates(
  tx: Tx,
  ctx: ToolContext,
  table: typeof sales | typeof expenses,
  occurredOn: string,
  totalPaisa: bigint,
  vendor?: { name?: string | undefined; invoiceNo?: string | undefined },
): Promise<ExistingEntryRef[]> {
  const refs: ExistingEntryRef[] = [];
  const sameDay = await tx
    .select()
    .from(table)
    .where(and(eq(table.tenantId, ctx.tenantId), eq(table.occurredOn, occurredOn)));
  for (const row of sameDay) {
    refs.push({
      id: row.id,
      totalPaisa: row.amountExclVatPaisa + row.vatPaisa,
      occurredOn: toDate(row.occurredOn),
      ...(('vendorName' in row && row.vendorName) ? { vendorName: row.vendorName } : {}),
      ...(('invoiceNo' in row && row.invoiceNo) ? { invoiceNo: row.invoiceNo } : {}),
      recordedOn: row.createdAt,
    });
  }
  if (table === expenses && vendor?.name && vendor.invoiceNo) {
    const byInvoice = await tx
      .select()
      .from(expenses)
      .where(
        and(
          eq(expenses.tenantId, ctx.tenantId),
          sql`lower(${expenses.vendorName}) = lower(${vendor.name})`,
          sql`lower(${expenses.invoiceNo}) = lower(${vendor.invoiceNo})`,
        ),
      );
    for (const row of byInvoice) {
      if (refs.some((r) => r.id === row.id)) continue;
      refs.push({
        id: row.id,
        totalPaisa: row.amountExclVatPaisa + row.vatPaisa,
        occurredOn: toDate(row.occurredOn),
        ...(row.vendorName ? { vendorName: row.vendorName } : {}),
        ...(row.invoiceNo ? { invoiceNo: row.invoiceNo } : {}),
        recordedOn: row.createdAt,
      });
    }
  }
  void totalPaisa; // engine does the matching; we only narrow the candidate set
  return refs;
}

/** Split an amount into (excl, vat): inclusive bills are divided, exclusive ones taxed. */
function splitAmount(amountPaisa: bigint, inclusive: boolean, vatApplies: boolean, cfg: TaxConfig) {
  if (!vatApplies) return { exclPaisa: amountPaisa, vatPaisa: 0n };
  if (inclusive) return splitVatInclusive(amountPaisa, cfg);
  return { exclPaisa: amountPaisa, vatPaisa: vatOnExclusive(amountPaisa, cfg) };
}

/** AD date range for a BS month, as ISO strings for indexed range scans. */
function monthRange(year: number, month: number): { fromIso: string; toIso: string } {
  const { from, to } = bsMonthRange(year, month);
  return { fromIso: toIso(from), toIso: toIso(to) };
}

const monthAggregate = async (
  tx: Tx,
  ctx: ToolContext,
  table: typeof sales | typeof expenses,
  vatColumn: typeof sales.vatPaisa | typeof expenses.inputVatPaisa,
  fromIso: string,
  toIsoDate: string,
): Promise<{ vat: bigint; count: number }> => {
  const [row] = await tx
    .select({
      vat: sql<string>`coalesce(sum(${vatColumn}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(table)
    .where(
      and(
        eq(table.tenantId, ctx.tenantId),
        eq(table.status, 'confirmed'),
        gte(table.occurredOn, fromIso),
        lte(table.occurredOn, toIsoDate),
      ),
    );
  return { vat: BigInt(row?.vat ?? '0'), count: row?.count ?? 0 };
};

// ---------------------------------------------------------------- tool implementations

type Args<K extends keyof typeof inputSchemas> = z.infer<z.ZodObject<(typeof inputSchemas)[K]>>;

export function createToolHandlers(ctx: ToolContext) {
  const inTenantTx = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(ctx.db, ctx.tenantId, fn);

  /**
   * Run an entry-creating tool body in ONE tenant tx, deduped by `key` (P9). The
   * body + the idempotency-key row commit together; a retry with the same key
   * returns the original result and writes nothing. `scope` is the tool name.
   */
  const idemTx = <T extends IdempotentResult>(scope: string, key: string | undefined, body: (tx: Tx) => Promise<T>) =>
    inTenantTx((tx) => withIdempotency(txIdempotencyStore(tx, ctx.tenantId), key, scope, () => body(tx)));

  return {
    ...createArapToolHandlers(ctx),
    async compute_vat(args: Args<'compute_vat'>) {
      const split = splitAmount(BigInt(args.amount_paisa), args.inclusive, true, ctx.cfg);
      return { excl_paisa: n(split.exclPaisa), vat_paisa: n(split.vatPaisa) };
    },

    async record_sale(args: Args<'record_sale'>) {
      const amount = BigInt(args.amount_paisa);
      const { exclPaisa, vatPaisa } = splitAmount(amount, args.inclusive, true, ctx.cfg);
      return idemTx('record_sale', args.idempotency_key, async (tx) => {
        const existing = await findDuplicateCandidates(tx, ctx, sales, args.occurred_on, exclPaisa + vatPaisa);
        const report = validateSale(
          {
            occurredOn: toDate(args.occurred_on),
            taxablePaisa: exclPaisa,
            vatPaisa,
            totalPaisa: exclPaisa + vatPaisa,
            ...(args.description !== undefined ? { description: args.description } : {}),
          },
          { asOf: new Date(), existing, cfg: ctx.cfg },
        );
        if (report.overall === 'fail') {
          await logWrite(tx, ctx, 'record_sale.rejected', { args }, { report, entryType: 'sale', entryId: null });
          return { saved: false as const, reason: 'validation failed — never saved', validation: serializeValidation(report) };
        }
        const [row] = await tx
          .insert(sales)
          .values({
            tenantId: ctx.tenantId,
            occurredOn: args.occurred_on,
            description: args.description ?? null,
            amountExclVatPaisa: exclPaisa,
            vatPaisa,
            paymentMethod: args.payment_method ?? null,
          })
          .returning({ id: sales.id });
        const saleId = row!.id;
        await logWrite(
          tx,
          ctx,
          'record_sale.draft',
          { sale_id: saleId, inclusive: args.inclusive, amount_paisa: args.amount_paisa },
          { report, entryType: 'sale', entryId: saleId },
        );
        return {
          saved: true as const,
          sale_id: saleId,
          status: 'draft' as const,
          amount_excl_vat_paisa: n(exclPaisa),
          vat_paisa: n(vatPaisa),
          assumption: args.inclusive ? 'amount treated as VAT-INCLUSIVE' : 'amount treated as VAT-EXCLUSIVE',
          validation: serializeValidation(report),
        };
      });
    },

    async record_expense(args: Args<'record_expense'>) {
      const amount = BigInt(args.amount_paisa);
      const { exclPaisa, vatPaisa } = splitAmount(amount, args.inclusive, args.vendor_is_vat_registered, ctx.cfg);
      const totalPaisa = exclPaisa + vatPaisa;
      const invoiceDate = toDate(args.occurred_on);

      const tds = computeTds(
        {
          category: args.is_service ? 'service_contract' : 'goods',
          baseExclVatPaisa: exclPaisa,
          recipientVatRegistered: args.vendor_is_vat_registered,
        },
        ctx.cfg,
      );
      const tdsComputed = tds.kind === 'computed' ? tds : null;

      return idemTx('record_expense', args.idempotency_key, async (tx) => {
        const existing = await findDuplicateCandidates(tx, ctx, expenses, args.occurred_on, totalPaisa, {
          name: args.vendor_name,
          invoiceNo: args.invoice_no,
        });
        const candidate: ExpenseCandidate = {
          vendorVatRegistered: args.vendor_is_vat_registered,
          invoiceDate,
          taxablePaisa: exclPaisa,
          vatPaisa,
          totalPaisa,
          forTaxableBusinessUse: args.for_taxable_business_use,
          ...(args.vendor_name !== undefined ? { vendorName: args.vendor_name } : {}),
          ...(args.invoice_no !== undefined ? { invoiceNo: args.invoice_no } : {}),
          ...(args.invoice_type !== undefined ? { invoiceType: args.invoice_type } : {}),
        };
        const report = validateExpense(candidate, { asOf: new Date(), existing, cfg: ctx.cfg });
        if (report.overall === 'fail') {
          await logWrite(tx, ctx, 'record_expense.rejected', { args }, { report, entryType: 'expense', entryId: null });
          return { saved: false as const, reason: 'validation failed — never saved', validation: serializeValidation(report) };
        }
        const inputVatPaisa = report.inputCreditEligible ? vatPaisa : 0n;
        const [row] = await tx
          .insert(expenses)
          .values({
            tenantId: ctx.tenantId,
            occurredOn: args.occurred_on,
            vendorName: args.vendor_name ?? null,
            vendorIsVatRegistered: args.vendor_is_vat_registered,
            category: args.category ?? (args.is_service ? 'service' : 'goods'),
            amountExclVatPaisa: exclPaisa,
            vatPaisa,
            inputVatPaisa,
            tdsRateBps: tdsComputed?.rateBps ?? 0,
            tdsPaisa: tdsComputed?.tdsPaisa ?? 0n,
            receiptFileId: args.receipt_file_id ?? null,
            invoiceNo: args.invoice_no ?? null,
            invoiceType: args.invoice_type ?? null,
            inputCreditEligible: report.inputCreditEligible,
            extraction: args.extraction ?? null,
          })
          .returning({ id: expenses.id });
        const expenseId = row!.id;
        await logWrite(
          tx,
          ctx,
          'record_expense.draft',
          { expense_id: expenseId, inclusive: args.inclusive, amount_paisa: args.amount_paisa },
          { report, entryType: 'expense', entryId: expenseId },
        );
        return {
          saved: true as const,
          expense_id: expenseId,
          status: 'draft' as const,
          amount_excl_vat_paisa: n(exclPaisa),
          vat_paisa: n(vatPaisa),
          input_vat_paisa: n(inputVatPaisa),
          input_credit_eligible: report.inputCreditEligible,
          input_credit_reasons: report.inputCreditReasons,
          tds:
            tds.kind === 'computed'
              ? { applies: true, rate_bps: tds.rateBps, tds_paisa: n(tds.tdsPaisa), base: 'amount EXCLUDING VAT' }
              : { applies: false, kind: tds.kind, reason: tds.reason },
          assumption: args.inclusive ? 'amount treated as VAT-INCLUSIVE' : 'amount treated as VAT-EXCLUSIVE',
          validation: serializeValidation(report),
        };
      });
    },

    async validate_entry(args: Args<'validate_entry'>) {
      const common = {
        ...(args.taxable_paisa !== undefined ? { taxablePaisa: BigInt(args.taxable_paisa) } : {}),
        ...(args.vat_paisa !== undefined ? { vatPaisa: BigInt(args.vat_paisa) } : {}),
        ...(args.total_paisa !== undefined ? { totalPaisa: BigInt(args.total_paisa) } : {}),
      };
      const vctx = { asOf: new Date(), existing: [], cfg: ctx.cfg };
      const report =
        args.entry_type === 'sale'
          ? validateSale(
              { ...common, ...(args.occurred_on ? { occurredOn: toDate(args.occurred_on) } : {}) },
              vctx,
            )
          : validateExpense(
              {
                ...common,
                ...(args.vendor_name !== undefined ? { vendorName: args.vendor_name } : {}),
                ...(args.vendor_is_vat_registered !== undefined
                  ? { vendorVatRegistered: args.vendor_is_vat_registered }
                  : {}),
                ...(args.invoice_no !== undefined ? { invoiceNo: args.invoice_no } : {}),
                ...(args.invoice_type !== undefined ? { invoiceType: args.invoice_type } : {}),
                ...(args.occurred_on ? { invoiceDate: toDate(args.occurred_on) } : {}),
                ...(args.for_taxable_business_use !== undefined
                  ? { forTaxableBusinessUse: args.for_taxable_business_use }
                  : {}),
              },
              vctx,
            );
      await inTenantTx((tx) =>
        logWrite(tx, ctx, 'validate_entry', { entry_type: args.entry_type }, { report, entryType: `${args.entry_type}_candidate`, entryId: null }),
      );
      return {
        ...serializeValidation(report),
        // Echo the validated figures back: the relay Audit Gate only delivers
        // outbound figures it can match against same-turn tool results, and
        // the agent must echo a bill BEFORE anything is saved.
        validated_figures: {
          ...(args.taxable_paisa !== undefined ? { taxable_paisa: args.taxable_paisa } : {}),
          ...(args.vat_paisa !== undefined ? { vat_paisa: args.vat_paisa } : {}),
          ...(args.total_paisa !== undefined ? { total_paisa: args.total_paisa } : {}),
        },
      };
    },

    async confirm_entry(args: Args<'confirm_entry'>) {
      const table = args.entry_type === 'sale' ? sales : expenses;
      return inTenantTx(async (tx) => {
        const updated = await tx
          .update(table)
          .set({ status: 'confirmed' })
          .where(and(eq(table.id, args.entry_id), eq(table.status, 'draft')))
          .returning({ id: table.id });
        if (updated.length === 0) {
          return {
            ok: false as const,
            reason: 'entry not found in this business, or already confirmed',
          };
        }
        await tx.insert(auditLog).values({
          tenantId: ctx.tenantId,
          actor: 'owner',
          action: 'confirm_entry',
          detail: { entry_type: args.entry_type, entry_id: args.entry_id },
        });
        return { ok: true as const, entry_id: args.entry_id, status: 'confirmed' as const };
      });
    },

    async generate_return_summary(args: Args<'generate_return_summary'>) {
      const { fromIso, toIso: toIsoDate } = monthRange(args.bs_year, args.bs_month);
      const deadline = vatFilingDeadline(args.bs_year, args.bs_month);
      return inTenantTx(async (tx) => {
        const [out, inp] = await Promise.all([
          monthAggregate(tx, ctx, sales, sales.vatPaisa, fromIso, toIsoDate),
          monthAggregate(tx, ctx, expenses, expenses.inputVatPaisa, fromIso, toIsoDate),
        ]);
        const position = netVatPosition(out.vat, inp.vat);
        const isNil = out.count === 0 && inp.count === 0;
        const [ret] = await tx
          .insert(vatReturns)
          .values({
            tenantId: ctx.tenantId,
            bsYear: args.bs_year,
            bsMonth: args.bs_month,
            outputVatPaisa: out.vat,
            inputVatPaisa: inp.vat,
            netPayablePaisa: position.netPayablePaisa,
            carryForwardPaisa: position.carryForwardPaisa,
            isNil,
          })
          .onConflictDoUpdate({
            target: [vatReturns.tenantId, vatReturns.bsYear, vatReturns.bsMonth],
            set: {
              outputVatPaisa: out.vat,
              inputVatPaisa: inp.vat,
              netPayablePaisa: position.netPayablePaisa,
              carryForwardPaisa: position.carryForwardPaisa,
              isNil,
              preparedAt: new Date(),
            },
          })
          .returning({ id: vatReturns.id });
        const returnId = ret!.id;
        await logWrite(tx, ctx, 'generate_return_summary', {
          return_id: returnId,
          bs_year: args.bs_year,
          bs_month: args.bs_month,
          net_payable_paisa: n(position.netPayablePaisa),
        });
        return {
          return_id: returnId,
          bs_year: args.bs_year,
          bs_month: args.bs_month,
          output_vat_paisa: n(out.vat),
          input_vat_paisa: n(inp.vat),
          net_payable_paisa: n(position.netPayablePaisa),
          carry_forward_paisa: n(position.carryForwardPaisa),
          is_nil: isNil,
          sale_count: out.count,
          expense_count: inp.count,
          counts_only: 'confirmed entries' as const,
          filing_deadline_ad: toIso(deadline.ad),
          note: 'PREPARED only — the owner files on the IRD portal. Verify the deadline via the IRD calendar before reminding.',
        };
      });
    },

    async list_transactions(args: Args<'list_transactions'>) {
      const { fromIso, toIso: toIsoDate } = monthRange(args.bs_year, args.bs_month);
      return inTenantTx(async (tx) => {
        const inMonth = <T extends typeof sales | typeof expenses>(table: T) =>
          and(
            eq(table.tenantId, ctx.tenantId),
            gte(table.occurredOn, fromIso),
            lte(table.occurredOn, toIsoDate),
            ...(args.status ? [eq(table.status, args.status)] : []),
          );
        const items: Array<Record<string, unknown>> = [];
        if (args.type !== 'expense') {
          for (const r of await tx.select().from(sales).where(inMonth(sales)).orderBy(sales.occurredOn)) {
            items.push({
              id: r.id,
              kind: 'sale',
              occurred_on: r.occurredOn,
              description: r.description,
              amount_excl_vat_paisa: n(r.amountExclVatPaisa),
              vat_paisa: n(r.vatPaisa),
              status: r.status,
            });
          }
        }
        if (args.type !== 'sale') {
          for (const r of await tx.select().from(expenses).where(inMonth(expenses)).orderBy(expenses.occurredOn)) {
            items.push({
              id: r.id,
              kind: 'expense',
              occurred_on: r.occurredOn,
              vendor_name: r.vendorName,
              amount_excl_vat_paisa: n(r.amountExclVatPaisa),
              vat_paisa: n(r.vatPaisa),
              input_vat_paisa: n(r.inputVatPaisa),
              input_credit_eligible: r.inputCreditEligible,
              status: r.status,
            });
          }
        }
        return { items, count: items.length };
      });
    },

    async mark_return_filed_by_user(args: Args<'mark_return_filed_by_user'>) {
      return inTenantTx(async (tx) => {
        const updated = await tx
          .update(vatReturns)
          .set({ status: 'confirmed_filed_by_user' })
          .where(and(eq(vatReturns.id, args.return_id), eq(vatReturns.status, 'prepared')))
          .returning({ id: vatReturns.id });
        if (updated.length === 0) {
          return { ok: false as const, reason: 'return not found in this business, or already marked filed' };
        }
        await tx.insert(auditLog).values({
          tenantId: ctx.tenantId,
          actor: 'owner',
          action: 'mark_return_filed_by_user',
          detail: { return_id: args.return_id },
        });
        return { ok: true as const, return_id: args.return_id, status: 'confirmed_filed_by_user' as const };
      });
    },

    async upsert_vendor(args: Args<'upsert_vendor'>) {
      return inTenantTx(async (tx) => {
        const [row] = await tx
          .insert(vendors)
          .values({
            tenantId: ctx.tenantId,
            name: args.name,
            panVatNo: args.pan_vat_no ?? null,
            isVatRegistered: args.is_vat_registered ?? null,
          })
          .onConflictDoUpdate({
            target: [vendors.tenantId, vendors.name],
            set: {
              ...(args.pan_vat_no !== undefined ? { panVatNo: args.pan_vat_no } : {}),
              ...(args.is_vat_registered !== undefined ? { isVatRegistered: args.is_vat_registered } : {}),
            },
          })
          .returning();
        await logWrite(tx, ctx, 'upsert_vendor', { name: args.name });
        const v = row!;
        return { vendor_id: v.id, name: v.name, pan_vat_no: v.panVatNo, is_vat_registered: v.isVatRegistered };
      });
    },

    async get_vendor(args: Args<'get_vendor'>) {
      return inTenantTx(async (tx) => {
        const [v] = await tx
          .select()
          .from(vendors)
          .where(and(eq(vendors.tenantId, ctx.tenantId), sql`lower(${vendors.name}) = lower(${args.name})`));
        return v
          ? { found: true as const, vendor_id: v.id, name: v.name, pan_vat_no: v.panVatNo, is_vat_registered: v.isVatRegistered }
          : { found: false as const };
      });
    },
  };
}

export const toolDescriptions: Record<keyof typeof inputSchemas, string> = {
  compute_vat: 'Pure VAT helper (no write): split an amount into excl + 13% VAT. inclusive=true divides, false adds.',
  record_sale:
    'Record a sale as a DRAFT (requires later confirm_entry after the owner explicitly approves). Amount is VAT-inclusive unless inclusive=false. Validation fail → nothing saved.',
  record_expense:
    'Record a purchase/expense as a DRAFT with input-VAT-credit eligibility and TDS computed on the VAT-exclusive base. Validation fail → nothing saved. Duplicates are flagged.',
  validate_entry: 'Run the Validation Engine on candidate figures WITHOUT saving. Use before asserting any figure.',
  confirm_entry: 'Flip a draft entry to confirmed. Call ONLY after the owner explicitly confirmed (OK / yes / सहि छ).',
  generate_return_summary:
    'Compute the VAT return for a BS month from CONFIRMED entries only (does NOT file). Net payable = max(output−input, 0); excess input carries forward.',
  list_transactions: 'List sales/expenses for a BS month (draft + confirmed unless filtered).',
  mark_return_filed_by_user: 'Owner confirmed they filed the return themselves on the IRD portal.',
  upsert_vendor: 'Remember a vendor (PAN, VAT status) so the owner is not re-asked every time.',
  get_vendor: 'Look up a remembered vendor by name (case-insensitive).',
  ...arapToolDescriptions,
};
