/**
 * Drizzle schema mirroring migrations/0001_init.sql (the SQL file is the source of
 * truth — it carries the RLS policies and grants drizzle cannot express).
 * Money columns are bigint paisa (mode: 'bigint').
 */
import {
  bigint,
  bigserial,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
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

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  actor: text('actor', { enum: ['agent', 'owner', 'system'] }).notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
