/**
 * Connector result payload schemas (PURE). The connector converts raw Tally XML into
 * these compact JSON shapes; the SERVER re-validates every result against these schemas
 * before a single figure can reach a tool response (raw XML never crosses the trust
 * boundary). A payload that fails its schema ⇒ trust state `failed`, never a number.
 *
 * Every string coming out of Tally (ledger names, groups, narrations…) is UNTRUSTED
 * DATA: it is length-capped here and only ever rendered as data — never interpreted
 * as instructions. Money travels as integer paisa + explicit side (see money.ts).
 */
import { z } from 'zod';
import { TALLY_OPERATIONS } from './types.js';

/** Wire money: integer paisa magnitude + explicit side (never a bare signed number). */
export const wireBalance = z.object({
  paisa: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  side: z.enum(['debit', 'credit']),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
/** Tally-sourced text: bounded, data-only. */
const tallyText = z.string().min(1).max(300);

export const healthPayload = z.object({
  tally_reachable: z.boolean(),
  tally_version: tallyText.optional(),
  companies_loaded: z.number().int().min(0).optional(),
});

export const companyEntry = z.object({
  /** stable source identifier — Tally company GUID when available, else name+books_from */
  source_id: tallyText,
  name: tallyText,
  books_from: isoDate.optional(),
  last_voucher_on: isoDate.optional(),
  currency: z.string().min(1).max(20).default('NPR'),
});
export const listCompaniesPayload = z.object({
  companies: z.array(companyEntry).max(100),
});

export const ledgerMatch = z.object({
  name: tallyText,
  group: z.string().max(300).default(''),
  closing: wireBalance.optional(),
});
export const searchLedgersPayload = z.object({
  matches: z.array(ledgerMatch).max(50),
  /** true when Tally had more matches than the cap — the owner must narrow the query */
  truncated: z.boolean().default(false),
});

export const ledgerBalancePayload = z.object({
  ledger: ledgerMatch.omit({ closing: true }),
  /** the period the figures actually cover (must equal the requested one or ⇒ partial) */
  from: isoDate.optional(),
  as_of: isoDate,
  opening: wireBalance,
  /**
   * Period movement totals, non-negative magnitudes. OPTIONAL because some Tally
   * exports omit them; when absent the closing balance CANNOT be cross-checked and
   * the tool downgrades the answer to verified_with_warnings — the connector must
   * never synthesize a Dr/Cr split (that would fabricate movement data).
   */
  total_debits_paisa: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  total_credits_paisa: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  closing: wireBalance,
});

export const receivableLine = z.object({
  party: tallyText,
  bill_ref: z.string().max(200).optional(),
  due_on: isoDate.optional(),
  balance: wireBalance,
});
export const receivablesPayload = z.object({
  as_of: isoDate,
  lines: z.array(receivableLine).max(2000),
  /**
   * The report-level total AS TALLY STATED IT — reconciled against the line sum
   * server-side. OPTIONAL: a collection-style export has no independent report total;
   * summing the lines ourselves and calling it Tally's total would make the
   * reconciliation circular, so an absent total downgrades to verified_with_warnings.
   */
  source_total: wireBalance.optional(),
});

/** Envelope every connector result travels in (op-specific payload validated separately). */
export const connectorResultEnvelope = z.object({
  op: z.enum(TALLY_OPERATIONS),
  ok: z.boolean(),
  /** set by the SIMULATOR only; production rejects results carrying this flag */
  simulator: z.boolean().default(false),
  tally_version: tallyText.optional(),
  /** which company the connector actually queried — must equal the requested one */
  company_source_id: tallyText.optional(),
  error: z.string().max(500).optional(),
  payload: z.unknown().optional(),
  duration_ms: z.number().int().min(0).optional(),
  connector_version: z.string().max(50).optional(),
});
export type ConnectorResultEnvelope = z.infer<typeof connectorResultEnvelope>;

/** Per-operation payload schema — the ONE map both server and connector validate against. */
export const OPERATION_PAYLOAD_SCHEMA = {
  health: healthPayload,
  list_companies: listCompaniesPayload,
  search_ledgers: searchLedgersPayload,
  get_ledger_balance: ledgerBalancePayload,
  get_receivables: receivablesPayload,
} as const;

export type HealthPayload = z.infer<typeof healthPayload>;
export type ListCompaniesPayload = z.infer<typeof listCompaniesPayload>;
export type SearchLedgersPayload = z.infer<typeof searchLedgersPayload>;
export type LedgerBalancePayload = z.infer<typeof ledgerBalancePayload>;
export type ReceivablesPayload = z.infer<typeof receivablesPayload>;
