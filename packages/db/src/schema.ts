/**
 * Drizzle schema mirroring migrations/0001_init.sql (the SQL file is the source of
 * truth — it carries the RLS policies and grants drizzle cannot express).
 * Money columns are bigint paisa (mode: 'bigint').
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessName: text('business_name').notNull(),
  panOrVatNo: text('pan_or_vat_no').notNull(),
  vatRegistered: boolean('vat_registered').notNull().default(true),
  whatsappE164: text('whatsapp_e164').unique(),
  status: text('status', { enum: ['pending', 'active', 'suspended'] })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

// ----- P8: identity & RBAC (mirrors 0010_identity_rbac.sql) -----

/** A verified WhatsApp identity. Global (a number can belong to many tenants). */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  whatsappE164: text('whatsapp_e164').unique().notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Links a user to a tenant with a role + invite lifecycle. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    role: text('role', { enum: ['owner', 'accountant', 'staff', 'viewer'] }).notNull(),
    status: text('status', { enum: ['invited', 'active', 'revoked'] })
      .notNull()
      .default('invited'),
    invitedBy: uuid('invited_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one live membership per (user, tenant); revoked rows don't block re-invite
    uniqueIndex('memberships_live_uq')
      .on(t.userId, t.tenantId)
      .where(sql`status <> 'revoked'`),
    index('memberships_tenant_status_idx').on(t.tenantId, t.status),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    panVatNo: text('pan_vat_no'),
    isVatRegistered: boolean('is_vat_registered'),
  },
  (t) => [uniqueIndex('vendors_tenant_id_name_key').on(t.tenantId, t.name)],
);

export const sales = pgTable('sales', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  occurredOn: date('occurred_on').notNull(),
  description: text('description'),
  amountExclVatPaisa: bigint('amount_excl_vat_paisa', { mode: 'bigint' }).notNull(),
  vatPaisa: bigint('vat_paisa', { mode: 'bigint' }).notNull(),
  paymentMethod: text('payment_method', { enum: ['cash', 'esewa', 'khalti', 'bank'] }),
  source: text('source', { enum: ['manual', 'gateway'] })
    .notNull()
    .default('manual'),
  gatewayRef: text('gateway_ref'),
  status: text('status', { enum: ['draft', 'confirmed'] })
    .notNull()
    .default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  occurredOn: date('occurred_on').notNull(),
  vendorName: text('vendor_name'),
  vendorIsVatRegistered: boolean('vendor_is_vat_registered').notNull().default(false),
  category: text('category'),
  amountExclVatPaisa: bigint('amount_excl_vat_paisa', { mode: 'bigint' }).notNull(),
  vatPaisa: bigint('vat_paisa', { mode: 'bigint' }).notNull().default(0n),
  inputVatPaisa: bigint('input_vat_paisa', { mode: 'bigint' }).notNull().default(0n),
  tdsRateBps: integer('tds_rate_bps').notNull().default(0),
  tdsPaisa: bigint('tds_paisa', { mode: 'bigint' }).notNull().default(0n),
  receiptFileId: text('receipt_file_id'),
  invoiceNo: text('invoice_no'),
  invoiceType: text('invoice_type', { enum: ['rule17', 'rule17ka', 'other'] }),
  inputCreditEligible: boolean('input_credit_eligible').notNull().default(false),
  extraction: jsonb('extraction'),
  status: text('status', { enum: ['draft', 'confirmed'] })
    .notNull()
    .default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const vatReturns = pgTable(
  'vat_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    bsYear: integer('bs_year').notNull(),
    bsMonth: integer('bs_month').notNull(),
    outputVatPaisa: bigint('output_vat_paisa', { mode: 'bigint' }).notNull(),
    inputVatPaisa: bigint('input_vat_paisa', { mode: 'bigint' }).notNull(),
    netPayablePaisa: bigint('net_payable_paisa', { mode: 'bigint' }).notNull(),
    carryForwardPaisa: bigint('carry_forward_paisa', { mode: 'bigint' }).notNull().default(0n),
    isNil: boolean('is_nil').notNull(),
    status: text('status', { enum: ['prepared', 'confirmed_filed_by_user'] })
      .notNull()
      .default('prepared'),
    summaryFileId: text('summary_file_id'),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('vat_returns_tenant_id_bs_year_bs_month_key').on(t.tenantId, t.bsYear, t.bsMonth)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actor: text('actor', { enum: ['agent', 'owner', 'system'] }).notNull(),
    action: text('action').notNull(),
    detail: jsonb('detail'),
    // Tamper-evident hash-chain (mirrors 0012). prev_hash/row_hash are set by the
    // chained-insert helper; nullable so pre-chain rows stay valid.
    prevHash: text('prev_hash'),
    rowHash: text('row_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_tenant_id_idx').on(t.tenantId, t.id)],
);

export const validationEvents = pgTable('validation_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  entryType: text('entry_type'),
  entryId: uuid('entry_id'),
  result: text('result', { enum: ['pass', 'warn', 'fail'] }).notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----- Phase 3 (WhatsApp): orchestrator-only tables (role hisab_orch) -----

/** Inbound idempotency: Meta retries webhooks; insert-or-conflict on the message id. */
export const waEvents = pgTable('wa_events', {
  waMessageId: text('wa_message_id').primaryKey(),
  fromE164: text('from_e164').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One persistent Managed Agents session per tenant. */
export const tenantSessions = pgTable('tenant_sessions', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  sessionId: text('session_id').notNull(),
  vaultId: text('vault_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----- Module C-1 (v1.2): Accounts Receivable / Payable -----

/** Unifies customers & suppliers (PRD v1.2 §C2). `vendors` stays for expense PAN memory. */
export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    panVatNo: text('pan_vat_no'),
    isVatRegistered: boolean('is_vat_registered'),
    kind: text('kind', { enum: ['customer', 'supplier', 'both'] })
      .notNull()
      .default('both'),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('parties_tenant_id_name_key').on(t.tenantId, t.name)],
);

/** Credit sales the business issued — `balancePaisa` decremented by allocations. */
export const arInvoices = pgTable('ar_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  partyId: uuid('party_id')
    .notNull()
    .references(() => parties.id),
  invoiceNo: text('invoice_no'),
  issuedOn: date('issued_on').notNull(),
  dueOn: date('due_on'),
  taxablePaisa: bigint('taxable_paisa', { mode: 'bigint' }).notNull(),
  vatPaisa: bigint('vat_paisa', { mode: 'bigint' }).notNull(),
  totalPaisa: bigint('total_paisa', { mode: 'bigint' }).notNull(),
  balancePaisa: bigint('balance_paisa', { mode: 'bigint' }).notNull(),
  status: text('status', { enum: ['draft', 'confirmed'] })
    .notNull()
    .default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Credit purchases the business owes — symmetric to ar_invoices, with input-credit flag. */
export const apBills = pgTable('ap_bills', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  partyId: uuid('party_id')
    .notNull()
    .references(() => parties.id),
  billNo: text('bill_no'),
  billedOn: date('billed_on').notNull(),
  dueOn: date('due_on'),
  taxablePaisa: bigint('taxable_paisa', { mode: 'bigint' }).notNull(),
  vatPaisa: bigint('vat_paisa', { mode: 'bigint' }).notNull(),
  totalPaisa: bigint('total_paisa', { mode: 'bigint' }).notNull(),
  balancePaisa: bigint('balance_paisa', { mode: 'bigint' }).notNull(),
  inputCreditEligible: boolean('input_credit_eligible').notNull().default(false),
  status: text('status', { enum: ['draft', 'confirmed'] })
    .notNull()
    .default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Payments received (AR) / paid (AP), allocated to specific invoices/bills. */
export const partyPayments = pgTable('party_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  partyId: uuid('party_id')
    .notNull()
    .references(() => parties.id),
  direction: text('direction', { enum: ['received', 'paid'] }).notNull(),
  amountPaisa: bigint('amount_paisa', { mode: 'bigint' }).notNull(),
  paidOn: date('paid_on').notNull(),
  method: text('method', { enum: ['cash', 'khalti', 'esewa', 'bank'] }),
  status: text('status', { enum: ['draft', 'confirmed'] })
    .notNull()
    .default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable allocation lines tying a payment to invoice/bill balances. */
export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => partyPayments.id),
  targetType: text('target_type', { enum: ['ar_invoice', 'ap_bill'] }).notNull(),
  targetId: uuid('target_id').notNull(),
  amountPaisa: bigint('amount_paisa', { mode: 'bigint' }).notNull(),
});

// ----- P9 (v2.0 §6): idempotent write keys for entry-creating tools -----

/**
 * Tool-layer exactly-once: a repeated entry-creating tool call with the same
 * client-supplied `key` returns the stored `result` and never inserts a second
 * row. Written by the RLS app role inside the entry's OWN tenant tx (key + entry
 * commit together). Tenant-scoped + RLS; append-only for the app.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scope, t.key] })],
);

// ----- Phase 5 (Payments): Khalti v2 live; eSewa/Fonepay coming soon -----

/**
 * One row per initiated payment. `pidx` is UNIQUE — replayed callbacks /
 * double verifies can never complete a payment twice; `saleId` being set is
 * the idempotency latch for the confirmed gateway sale.
 */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  provider: text('provider').notNull().default('khalti'),
  pidx: text('pidx').notNull().unique(),
  purchaseOrderId: text('purchase_order_id').notNull(),
  purchaseOrderName: text('purchase_order_name').notNull(),
  amountPaisa: bigint('amount_paisa', { mode: 'bigint' }).notNull(),
  status: text('status', {
    enum: ['initiated', 'completed', 'canceled', 'expired', 'refunded', 'amount_mismatch'],
  })
    .notNull()
    .default('initiated'),
  transactionId: text('transaction_id'),
  feePaisa: bigint('fee_paisa', { mode: 'bigint' }).notNull().default(0n),
  saleId: uuid('sale_id').references(() => sales.id),
  paymentUrl: text('payment_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----- P10 (v2.0 §2): subscription billing — the SMB pays HisabKitab -----

/**
 * One subscription per tenant. Prepaid period: a completed billing_payment extends
 * `currentPeriodEnd`. Lifecycle trial→active→past_due→suspended→cancelled is computed
 * by the pure @hisab/shared/billing module. `lastDunned*` latch the dunning pass so a
 * daily scan never double-sends a renewal nudge or double-suspends.
 */
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .unique()
    .references(() => tenants.id),
  planCode: text('plan_code').notNull(),
  status: text('status', { enum: ['trial', 'active', 'past_due', 'suspended', 'cancelled'] })
    .notNull()
    .default('trial'),
  currentPeriodEnd: date('current_period_end').notNull(),
  lastDunnedStage: text('last_dunned_stage'),
  lastDunnedFor: date('last_dunned_for'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A tenant's payment to US (distinct from `payments`, which is their customer paying them). */
export const billingPayments = pgTable('billing_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  planCode: text('plan_code').notNull(),
  gateway: text('gateway').notNull().default('khalti'),
  pidx: text('pidx').notNull().unique(),
  purchaseOrderId: text('purchase_order_id').notNull(),
  amountPaisa: bigint('amount_paisa', { mode: 'bigint' }).notNull(),
  status: text('status', {
    enum: ['initiated', 'completed', 'canceled', 'expired', 'refunded', 'amount_mismatch'],
  })
    .notNull()
    .default('initiated'),
  transactionId: text('transaction_id'),
  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  paymentUrl: text('payment_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----- Phase 6: monthly VAT-return reminder scheduler -----

/**
 * Exactly-once latch for proactive reminders. The unique (tenant, bs_year,
 * bs_month, kind) guarantees a given reminder is sent at most once however many
 * times the BullMQ job ticks/retries. Written by the orchestrator (hisab_orch),
 * like wa_events — never the RLS app role.
 */
export const reminderLog = pgTable(
  'reminder_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    bsYear: integer('bs_year').notNull(),
    bsMonth: integer('bs_month').notNull(),
    kind: text('kind', { enum: ['return_prepared', 'vat_due_soon'] }).notNull(),
    verdict: text('verdict', { enum: ['PASS', 'FAIL', 'BLOCKED'] }).notNull(),
    netPayablePaisa: bigint('net_payable_paisa', { mode: 'bigint' }),
    isNil: boolean('is_nil'),
    detail: text('detail'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reminder_log_tenant_id_bs_year_bs_month_kind_key').on(t.tenantId, t.bsYear, t.bsMonth, t.kind)],
);

// ----- Phase 7 (hardening): tenant data-deletion proof -----

/**
 * Proof that a tenant's "delete my data" request was honored. Deliberately has
 * NO foreign key to tenants — the tenant row is deleted, but this record must
 * survive it (data-free: counts + ids only, never the deleted content). Written
 * by the orchestrator (hisab_orch).
 */
export const deletionLog = pgTable('deletion_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(), // no FK — the tenant is gone
  reason: text('reason').notNull(),
  rowsDeleted: integer('rows_deleted').notNull(),
  sessionsDeleted: integer('sessions_deleted').notNull().default(0),
  detail: jsonb('detail'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
});
