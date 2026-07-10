/**
 * The connector's operation allowlist — the ONLY things it will do to TallyPrime,
 * all reads. Job params arrive from the server but are STILL schema-validated here
 * (zod): a compromised server account cannot make the connector run anything outside
 * these five typed reads, and no raw XML/TDL/SQL can be smuggled through params.
 */
import { z } from 'zod';
import {
  resolveLedgerQuery,
  type HealthPayload,
  type ListCompaniesPayload,
  type LedgerBalancePayload,
  type ReceivablesPayload,
  type SearchLedgersPayload,
  type TallyOperation,
} from '@hisab/shared';
import { TallyClient } from './tally-client.js';
import {
  parseBills,
  parseCompanies,
  parseLedgers,
  requests,
  toLedgerBalancePayload,
  toSearchPayload,
  TallyParseError,
} from './xml.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const companyScoped = z.object({ company_source_id: z.string().min(1).max(300) });

const paramSchemas = {
  health: z.object({}).loose(),
  list_companies: z.object({}).loose(),
  search_ledgers: companyScoped.extend({ query: z.string().min(1).max(200) }),
  get_ledger_balance: companyScoped.extend({
    ledger_name: z.string().min(1).max(300),
    as_of: isoDate.optional(),
  }),
  get_receivables: companyScoped.extend({ as_of: isoDate.optional() }),
} satisfies Record<TallyOperation, z.ZodType>;

export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export interface ExecuteResult {
  payload:
    | HealthPayload
    | ListCompaniesPayload
    | SearchLedgersPayload
    | LedgerBalancePayload
    | ReceivablesPayload;
  companySourceId?: string;
}

/**
 * Company scoping: the server sends the STABLE source_id; Tally requests are scoped
 * by company NAME (SVCURRENTCOMPANY). We re-list companies and refuse to query when
 * the source_id no longer resolves — never "the nearest name".
 */
async function companyNameFor(client: TallyClient, sourceId: string): Promise<string> {
  const companies = parseCompanies(await client.post(requests.listCompanies())).companies;
  const company = companies.find((c) => c.source_id === sourceId);
  if (!company)
    throw new OperationError(`company ${sourceId} is not loaded in TallyPrime right now`);
  return company.name;
}

export function createOperations(client: TallyClient) {
  return {
    async health(): Promise<ExecuteResult> {
      const reachable = await client.ping();
      if (!reachable) return { payload: { tally_reachable: false } };
      const companies = parseCompanies(await client.post(requests.listCompanies())).companies;
      return { payload: { tally_reachable: true, companies_loaded: companies.length } };
    },

    async list_companies(): Promise<ExecuteResult> {
      return { payload: parseCompanies(await client.post(requests.listCompanies())) };
    },

    async search_ledgers(
      params: z.infer<(typeof paramSchemas)['search_ledgers']>,
    ): Promise<ExecuteResult> {
      const companyName = await companyNameFor(client, params.company_source_id);
      const ledgers = parseLedgers(await client.post(requests.ledgers(companyName)));
      return {
        payload: toSearchPayload(ledgers, params.query),
        companySourceId: params.company_source_id,
      };
    },

    async get_ledger_balance(
      params: z.infer<(typeof paramSchemas)['get_ledger_balance']>,
    ): Promise<ExecuteResult> {
      const asOf = params.as_of ?? todayIso();
      const companyName = await companyNameFor(client, params.company_source_id);
      const ledgers = parseLedgers(await client.post(requests.ledgers(companyName, { asOf })));
      // EXACT resolution only — an ambiguous or missing name is refused here; the
      // server-side search tool is where candidates are offered to the owner.
      const resolution = resolveLedgerQuery(params.ledger_name, ledgers);
      if (resolution.kind !== 'exact') {
        throw new OperationError(
          resolution.kind === 'none'
            ? `no ledger named "${params.ledger_name}" in this company`
            : `ledger name "${params.ledger_name}" is ambiguous — resolve it with search first`,
        );
      }
      const ledger = ledgers.find(
        (l) => l.name === resolution.match.name && l.group === resolution.match.group,
      );
      if (!ledger) throw new OperationError('resolved ledger disappeared from the export');
      return {
        payload: toLedgerBalancePayload(ledger, asOf),
        companySourceId: params.company_source_id,
      };
    },

    async get_receivables(
      params: z.infer<(typeof paramSchemas)['get_receivables']>,
    ): Promise<ExecuteResult> {
      const asOf = params.as_of ?? todayIso();
      const companyName = await companyNameFor(client, params.company_source_id);
      const payload = parseBills(await client.post(requests.bills(companyName, { asOf })), asOf);
      return { payload, companySourceId: params.company_source_id };
    },
  } satisfies Record<TallyOperation, (params: never) => Promise<ExecuteResult>>;
}

/** Validate + dispatch one claimed job. Anything not allowlisted is refused. */
export async function executeOperation(
  client: TallyClient,
  operation: string,
  rawParams: unknown,
): Promise<ExecuteResult> {
  if (!(operation in paramSchemas))
    throw new OperationError(`operation "${operation}" is not allowlisted`);
  const op = operation as TallyOperation;
  const params = paramSchemas[op].parse(rawParams ?? {});
  const ops = createOperations(client);
  try {
    return await (ops[op] as (p: unknown) => Promise<ExecuteResult>)(params);
  } catch (err) {
    // Parse failures are operational failures (fail closed), not crashes.
    if (err instanceof TallyParseError) throw new OperationError(err.message);
    throw err;
  }
}
