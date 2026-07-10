/**
 * Tally MCP tools — READ-ONLY, typed, allowlisted. The agent can ASK TallyPrime
 * (pull); nothing here can create, alter or delete anything in Tally (no push).
 *
 * Trust contract on every answer: `trust` is one of the shared TallyTrustStates and
 * only `verified` / `verified_with_warnings` results carry figures. Everything else
 * explains what could not be verified. Figures are integer paisa + a deterministic
 * NPR string (formatNpr) — the model never computes or reformats money itself, and
 * the orchestrator's Pre-delivery Audit Gate checks outbound numbers against these
 * tool results like every other ledger figure.
 *
 * Ambiguity is NEVER auto-resolved: "Sharma" matching 3 ledgers returns the sorted
 * candidates for the owner to pick (resolveLedgerQuery). Every string that came out
 * of Tally is untrusted DATA — bounded by the payload schemas, echoed only as values.
 */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { appendAudit, schema, withTenant, type Db, type Tx } from '@hisab/db';
import {
  balanceToSignedPaisa,
  formatNpr,
  OPERATION_PAYLOAD_SCHEMA,
  reconcileLedgerBalance,
  reconcileReceivables,
  resolveLedgerQuery,
  signedPaisaToBalance,
  type Capability,
  type ConnectorResultEnvelope,
  type Role,
  type TallyBalance,
  type TallyTrustState,
} from '@hisab/shared';
import {
  CONNECTOR_STALE_MS,
  dispatchToConnector,
  getActiveConnector,
  isConnectorStale,
  type DispatchOutcome,
} from './jobs.js';
import { newSetupCode, SETUP_CODE_TTL_MS } from './connector-api.js';

const { tallyConnectors, tallyCompanies } = schema;

// ---------------------------------------------------------------- zod building blocks

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const inputSchemas = {
  tally_connect: {},
  tally_status: {},
  tally_list_companies: {},
  tally_bind_company: {
    company_source_id: z
      .string()
      .min(1)
      .max(300)
      .describe('the source_id of the company to bind, from tally_list_companies'),
  },
  tally_search_ledgers: {
    query: z.string().min(1).max(200).describe('ledger name or part of it, e.g. "Sharma"'),
  },
  tally_get_ledger_balance: {
    ledger_name: z
      .string()
      .min(1)
      .max(300)
      .describe('the EXACT Tally ledger name (resolve with tally_search_ledgers first)'),
    as_of: isoDate.optional().describe('balance as of this date; omit for today'),
  },
  tally_get_receivables: {
    as_of: isoDate.optional().describe('receivables as of this date; omit for today'),
  },
} as const;

export const toolDescriptions: Record<keyof typeof inputSchemas, string> = {
  tally_connect:
    'Set up (or re-set-up) the TallyPrime connector for this business. Returns a one-time setup ' +
    'code the owner types into the HisabKitab Tally Connector on the computer that runs TallyPrime. ' +
    'Owner only. Read-only integration: HisabKitab can ASK Tally, never write to it.',
  tally_status:
    'Check the TallyPrime link: is the connector online, when was it last seen, which Tally ' +
    'company is bound, and how fresh the link is. Use this first when a Tally question fails.',
  tally_list_companies:
    'List the companies available in the connected TallyPrime (live from Tally). Also refreshes ' +
    'the company catalog. The owner then binds one with tally_bind_company.',
  tally_bind_company:
    'Bind ONE Tally company (by source_id from tally_list_companies) as the company this ' +
    'business queries. Owner only. Companies are never merged or guessed by name.',
  tally_search_ledgers:
    'Find Tally ledgers by (partial) name in the bound company. Returns an exact match, or a ' +
    'deterministic candidate list the OWNER must choose from — never auto-picks, never guesses.',
  tally_get_ledger_balance:
    'Live TallyPrime ledger balance (opening, period debits/credits, closing) for an EXACT ledger ' +
    'name, independently reconciled (opening + credits − debits must equal closing) before any ' +
    'figure is returned. State ONLY figures this tool returned.',
  tally_get_receivables:
    'Live receivables (who owes the business) from TallyPrime bills, with the report total ' +
    'independently reconciled against the line sum. State ONLY figures this tool returned.',
};

/**
 * RBAC map (same contract as the ledger: enforced in server.ts BEFORE the handler,
 * deny-by-default). Reads are `generate_report` → owner, accountant and viewer may
 * ask Tally; staff may not. Connector setup / company binding are management actions
 * → `manage_billing` (owner only).
 */
export const TOOL_CAPABILITY: Record<keyof typeof inputSchemas, Capability> = {
  tally_connect: 'manage_billing',
  tally_status: 'generate_report',
  tally_list_companies: 'generate_report',
  tally_bind_company: 'manage_billing',
  tally_search_ledgers: 'generate_report',
  tally_get_ledger_balance: 'generate_report',
  tally_get_receivables: 'generate_report',
};

export interface ToolContext {
  db: Db;
  tenantId: string;
  role: Role;
  correlationId?: string;
}

type Args<K extends keyof typeof inputSchemas> = z.infer<z.ZodObject<(typeof inputSchemas)[K]>>;

/** Wire balance → NPR string with an explicit Dr/Cr marker (deterministic rendering). */
const renderBalance = (b: TallyBalance): string =>
  `NPR ${formatNpr(BigInt(b.paisa))} ${b.side === 'debit' ? 'Dr' : 'Cr'}`;

/** Map a non-ok dispatch onto the trust contract (single place, DRY). */
function dispatchFailure(outcome: Exclude<DispatchOutcome, { kind: 'ok' }>): {
  trust: TallyTrustState;
  reason: string;
} {
  return {
    trust:
      outcome.kind === 'unavailable'
        ? 'unavailable'
        : outcome.kind === 'timeout'
          ? 'unavailable'
          : 'failed',
    reason: outcome.reason,
  };
}

const SOURCE = 'TallyPrime (read-only connector)';

export function createToolHandlers(ctx: ToolContext) {
  const { db, tenantId } = ctx;
  const inTenantTx = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db, tenantId, fn);
  const audit = (tx: Tx, action: string, detail: Record<string, unknown>) =>
    appendAudit(tx, tenantId, { actor: 'agent', action, detail });
  const dispatch = (
    op: Parameters<typeof dispatchToConnector>[1],
    params: Record<string, unknown>,
  ) =>
    dispatchToConnector({ db, tenantId }, op, params, {
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    });

  /** The company the owner bound for queries (tenant-scoped read). */
  async function getBoundCompany(tx: Tx) {
    const [row] = await tx
      .select({
        id: tallyCompanies.id,
        sourceId: tallyCompanies.sourceId,
        name: tallyCompanies.name,
        booksFrom: tallyCompanies.booksFrom,
        currency: tallyCompanies.currency,
        lastSyncedAt: tallyCompanies.lastSyncedAt,
      })
      .from(tallyCompanies)
      .where(and(eq(tallyCompanies.tenantId, tenantId), eq(tallyCompanies.isBound, true)))
      .limit(1);
    return row ?? null;
  }

  /** Company echo check: the connector must have answered for the company we asked. */
  const wrongCompany = (envelope: ConnectorResultEnvelope, expectedSourceId: string): boolean =>
    envelope.company_source_id !== undefined && envelope.company_source_id !== expectedSourceId;

  /** Metadata block every verified answer carries (source, freshness, audit id). */
  const evidence = (
    envelope: ConnectorResultEnvelope,
    company: { sourceId: string; name: string },
  ) => ({
    source: SOURCE,
    source_interface: envelope.simulator
      ? 'SIMULATOR (not real Tally)'
      : 'Tally XML/HTTP (localhost)',
    company: company.name,
    company_source_id: company.sourceId,
    ...(envelope.tally_version ? { tally_version: envelope.tally_version } : {}),
    freshness: 'live query just now',
    queried_at: new Date().toISOString(),
  });

  return {
    async tally_connect(_args: Args<'tally_connect'>) {
      const code = newSetupCode();
      return inTenantTx(async (tx) => {
        // Any lingering un-registered code is superseded (revoked), then one fresh
        // pending connector row carries the new code. Existing ACTIVE connectors are
        // untouched — re-running setup must not kill a working link until the new
        // install registers.
        await tx
          .update(tallyConnectors)
          .set({ status: 'revoked', setupCode: null, setupCodeExpiresAt: null })
          .where(
            and(eq(tallyConnectors.tenantId, tenantId), eq(tallyConnectors.status, 'pending')),
          );
        await tx.insert(tallyConnectors).values({
          tenantId,
          setupCode: code,
          setupCodeExpiresAt: new Date(Date.now() + SETUP_CODE_TTL_MS),
        });
        await audit(tx, 'tally_connect', { setup_code_issued: true });
        return {
          setup_code: code,
          expires_in_minutes: SETUP_CODE_TTL_MS / 60_000,
          instructions: [
            'On the computer that runs TallyPrime: download and start the HisabKitab Tally Connector.',
            `When it asks, type this setup code: ${code} (valid ${SETUP_CODE_TTL_MS / 60_000} minutes).`,
            'Keep TallyPrime open with your company loaded. That is all — the connector does the rest.',
          ],
          note: 'Read-only: HisabKitab can ask Tally questions but can never change anything in Tally.',
        };
      });
    },

    async tally_status(_args: Args<'tally_status'>) {
      const connector = await getActiveConnector({ db, tenantId });
      return inTenantTx(async (tx) => {
        const company = await getBoundCompany(tx);
        await audit(tx, 'tally_status', {
          connector_online: connector !== null && !isConnectorStale(connector.lastSeenAt),
        });
        if (!connector) {
          return {
            trust: 'unavailable' satisfies TallyTrustState,
            connector: 'not set up',
            note: 'No TallyPrime connector yet. The owner can say "connect my Tally" to get a setup code.',
          };
        }
        const stale = isConnectorStale(connector.lastSeenAt);
        return {
          trust: (stale ? 'stale' : 'verified') satisfies TallyTrustState,
          connector: stale ? 'offline / not checking in' : 'online',
          last_seen_at: connector.lastSeenAt?.toISOString() ?? null,
          stale_after_ms: CONNECTOR_STALE_MS,
          connector_version: connector.connectorVersion,
          bound_company: company ? { name: company.name, source_id: company.sourceId } : null,
          ...(company?.lastSyncedAt
            ? { company_last_refreshed_at: company.lastSyncedAt.toISOString() }
            : {}),
          note: stale
            ? 'The computer running TallyPrime seems off or offline — figures cannot be fetched right now.'
            : company
              ? 'Live Tally questions are available.'
              : 'Connector online, but no company is bound yet — run tally_list_companies, then bind one.',
        };
      });
    },

    async tally_list_companies(_args: Args<'tally_list_companies'>) {
      const outcome = await dispatch('list_companies', {});
      if (outcome.kind !== 'ok') {
        const f = dispatchFailure(outcome);
        return { trust: f.trust, companies: [], note: f.reason };
      }
      const payload = OPERATION_PAYLOAD_SCHEMA.list_companies.safeParse(outcome.envelope.payload);
      if (!payload.success) {
        return {
          trust: 'failed' satisfies TallyTrustState,
          companies: [],
          note: 'Tally answered but the company list failed validation — nothing was trusted.',
        };
      }
      return inTenantTx(async (tx) => {
        // Refresh the catalog: identity is (connector, source_id) — never the name.
        for (const c of payload.data.companies) {
          await tx
            .insert(tallyCompanies)
            .values({
              tenantId,
              connectorId: outcome.connectorId,
              sourceId: c.source_id,
              name: c.name,
              booksFrom: c.books_from ?? null,
              lastVoucherOn: c.last_voucher_on ?? null,
              currency: c.currency,
              lastSyncedAt: sql`now()`,
            })
            .onConflictDoUpdate({
              target: [tallyCompanies.connectorId, tallyCompanies.sourceId],
              set: {
                name: c.name,
                booksFrom: c.books_from ?? null,
                lastVoucherOn: c.last_voucher_on ?? null,
                currency: c.currency,
                lastSyncedAt: sql`now()`,
              },
            });
        }
        const bound = await getBoundCompany(tx);
        await audit(tx, 'tally_list_companies', { count: payload.data.companies.length });
        return {
          trust: 'verified' satisfies TallyTrustState,
          companies: payload.data.companies.map((c) => ({
            source_id: c.source_id,
            name: c.name,
            books_from: c.books_from ?? null,
            last_voucher_on: c.last_voucher_on ?? null,
            currency: c.currency,
            is_bound: bound?.sourceId === c.source_id,
          })),
          note:
            bound === null && payload.data.companies.length > 0
              ? 'No company is bound yet — ask the owner which one to use, then call tally_bind_company.'
              : undefined,
        };
      });
    },

    async tally_bind_company(args: Args<'tally_bind_company'>) {
      return inTenantTx(async (tx) => {
        const [target] = await tx
          .select({ id: tallyCompanies.id, name: tallyCompanies.name })
          .from(tallyCompanies)
          .where(
            and(
              eq(tallyCompanies.tenantId, tenantId),
              eq(tallyCompanies.sourceId, args.company_source_id),
            ),
          )
          .limit(1);
        if (!target) {
          return {
            trust: 'failed' satisfies TallyTrustState,
            note: 'That company is not in the catalog — run tally_list_companies first and use its source_id.',
          };
        }
        await tx
          .update(tallyCompanies)
          .set({ isBound: false })
          .where(eq(tallyCompanies.tenantId, tenantId));
        await tx
          .update(tallyCompanies)
          .set({ isBound: true })
          .where(eq(tallyCompanies.id, target.id));
        await audit(tx, 'tally_bind_company', { company_source_id: args.company_source_id });
        return {
          trust: 'verified' satisfies TallyTrustState,
          bound_company: { name: target.name, source_id: args.company_source_id },
          note: `Tally questions now answer from "${target.name}".`,
        };
      });
    },

    async tally_search_ledgers(args: Args<'tally_search_ledgers'>) {
      const company = await inTenantTx(getBoundCompany);
      if (!company) {
        return {
          trust: 'unavailable' satisfies TallyTrustState,
          note: 'No Tally company is bound yet — run tally_list_companies and bind one first.',
        };
      }
      const outcome = await dispatch('search_ledgers', {
        query: args.query,
        company_source_id: company.sourceId,
      });
      if (outcome.kind !== 'ok') {
        const f = dispatchFailure(outcome);
        return { trust: f.trust, note: f.reason };
      }
      const payload = OPERATION_PAYLOAD_SCHEMA.search_ledgers.safeParse(outcome.envelope.payload);
      if (!payload.success || wrongCompany(outcome.envelope, company.sourceId)) {
        return {
          trust: 'failed' satisfies TallyTrustState,
          note: 'Tally answered but the ledger list failed validation — nothing was trusted.',
        };
      }
      const resolution = resolveLedgerQuery(args.query, payload.data.matches);
      return inTenantTx(async (tx) => {
        await audit(tx, 'tally_search_ledgers', {
          query: args.query,
          resolution: resolution.kind,
          matches: payload.data.matches.length,
        });
        const base = { ...evidence(outcome.envelope, company), query: args.query };
        switch (resolution.kind) {
          case 'exact':
            return {
              trust: 'verified' satisfies TallyTrustState,
              resolution: 'exact',
              ledger: resolution.match,
              ...base,
            };
          case 'ambiguous':
            return {
              trust: 'ambiguous' satisfies TallyTrustState,
              resolution: 'ambiguous',
              candidates: resolution.candidates,
              ...base,
              note:
                'Several ledgers match — show the owner this list (name + group) and ask which one; ' +
                'never pick one yourself.',
            };
          case 'none':
            return {
              trust: 'verified' satisfies TallyTrustState,
              resolution: 'none',
              ...base,
              note: `No ledger in "${company.name}" matches "${args.query}". Do not guess an alternative.`,
            };
        }
      });
    },

    async tally_get_ledger_balance(args: Args<'tally_get_ledger_balance'>) {
      const company = await inTenantTx(getBoundCompany);
      if (!company) {
        return {
          trust: 'unavailable' satisfies TallyTrustState,
          note: 'No Tally company is bound yet — run tally_list_companies and bind one first.',
        };
      }
      const outcome = await dispatch('get_ledger_balance', {
        ledger_name: args.ledger_name,
        company_source_id: company.sourceId,
        ...(args.as_of ? { as_of: args.as_of } : {}),
      });
      if (outcome.kind !== 'ok') {
        const f = dispatchFailure(outcome);
        return { trust: f.trust, note: f.reason };
      }
      const payload = OPERATION_PAYLOAD_SCHEMA.get_ledger_balance.safeParse(
        outcome.envelope.payload,
      );
      if (!payload.success || wrongCompany(outcome.envelope, company.sourceId)) {
        return {
          trust: 'failed' satisfies TallyTrustState,
          note: 'Tally answered but the balance failed validation — no figure was trusted. Try again.',
        };
      }
      const recon = reconcileLedgerBalance(payload.data);
      return inTenantTx(async (tx) => {
        await audit(tx, 'tally_get_ledger_balance', {
          ledger: args.ledger_name,
          as_of: payload.data.as_of,
          reconciled: recon.ok,
        });
        if (!recon.ok) {
          return {
            trust: 'failed' satisfies TallyTrustState,
            note:
              'The figures Tally returned do not reconcile (opening + movements ≠ closing), so no ' +
              'balance is stated. Tell the owner the figure could not be verified and to retry.',
          };
        }
        const p = payload.data;
        const warnings: string[] = [];
        if (args.as_of !== undefined && args.as_of !== p.as_of) {
          warnings.push(
            `You asked as of ${args.as_of} but Tally answered as of ${p.as_of} — say so to the owner.`,
          );
        }
        if (!recon.checked) {
          warnings.push(
            'Tally did not return movement totals, so the closing balance could not be independently ' +
              'cross-checked this time — mention that when stating it.',
          );
        }
        return {
          trust: (warnings.length > 0
            ? 'verified_with_warnings'
            : 'verified') satisfies TallyTrustState,
          ledger: p.ledger,
          as_of: p.as_of,
          opening: { ...p.opening, npr: renderBalance(p.opening) },
          ...(p.total_debits_paisa !== undefined
            ? {
                total_debits_paisa: p.total_debits_paisa,
                total_debits_npr: `NPR ${formatNpr(BigInt(p.total_debits_paisa))}`,
              }
            : {}),
          ...(p.total_credits_paisa !== undefined
            ? {
                total_credits_paisa: p.total_credits_paisa,
                total_credits_npr: `NPR ${formatNpr(BigInt(p.total_credits_paisa))}`,
              }
            : {}),
          closing: { ...p.closing, npr: renderBalance(p.closing) },
          reconciled: recon.checked
            ? 'opening + credits − debits = closing ✓ (checked independently)'
            : 'not cross-checked (movement totals unavailable)',
          ...evidence(outcome.envelope, company),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      });
    },

    async tally_get_receivables(args: Args<'tally_get_receivables'>) {
      const company = await inTenantTx(getBoundCompany);
      if (!company) {
        return {
          trust: 'unavailable' satisfies TallyTrustState,
          note: 'No Tally company is bound yet — run tally_list_companies and bind one first.',
        };
      }
      const outcome = await dispatch('get_receivables', {
        company_source_id: company.sourceId,
        ...(args.as_of ? { as_of: args.as_of } : {}),
      });
      if (outcome.kind !== 'ok') {
        const f = dispatchFailure(outcome);
        return { trust: f.trust, note: f.reason };
      }
      const payload = OPERATION_PAYLOAD_SCHEMA.get_receivables.safeParse(outcome.envelope.payload);
      if (!payload.success || wrongCompany(outcome.envelope, company.sourceId)) {
        return {
          trust: 'failed' satisfies TallyTrustState,
          note: 'Tally answered but the receivables failed validation — no figure was trusted.',
        };
      }
      const recon = reconcileReceivables(payload.data);
      return inTenantTx(async (tx) => {
        await audit(tx, 'tally_get_receivables', {
          as_of: payload.data.as_of,
          lines: payload.data.lines.length,
          reconciled: recon.ok,
        });
        if (!recon.ok) {
          return {
            trust: 'failed' satisfies TallyTrustState,
            note:
              'The receivables lines do not add up to the report total Tally stated, so no figure ' +
              'is given. Tell the owner it could not be verified and to retry.',
          };
        }
        const p = payload.data;
        // Deterministic total: Tally's own report total when it gave one (reconciled
        // above); otherwise the exact Σ of lines, labelled as not independently confirmed.
        const total =
          p.source_total ??
          signedPaisaToBalance(
            p.lines.reduce((sum, l) => sum + balanceToSignedPaisa(l.balance), 0),
          );
        return {
          trust: (recon.checked ? 'verified' : 'verified_with_warnings') satisfies TallyTrustState,
          as_of: p.as_of,
          total: { ...total, npr: renderBalance(total) },
          count: p.lines.length,
          lines: p.lines.map((l) => ({
            party: l.party,
            ...(l.bill_ref ? { bill_ref: l.bill_ref } : {}),
            ...(l.due_on ? { due_on: l.due_on } : {}),
            balance: { ...l.balance, npr: renderBalance(l.balance) },
          })),
          reconciled: recon.checked
            ? `Σ ${p.lines.length} bills = report total ✓ (checked independently)`
            : 'total is the exact sum of the listed bills (Tally gave no separate report total to check against)',
          ...evidence(outcome.envelope, company),
          ...(recon.checked
            ? {}
            : {
                warnings: [
                  'Tally returned no independent report total, so the sum could not be cross-checked — mention that.',
                ],
              }),
        };
      });
    },
  };
}
