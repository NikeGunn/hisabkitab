/**
 * Job dispatch: the bridge between a tenant-scoped tool call and the customer-side
 * connector. The tool INSERTs an allowlisted job row and polls for the result; the
 * connector (authenticated separately, see connector-api.ts) claims it, runs it
 * against localhost TallyPrime and posts the result back.
 *
 * Fail-closed rules:
 *   - no active connector, or a stale one ⇒ `unavailable` immediately (no queue wait);
 *   - result must parse as a ConnectorResultEnvelope or ⇒ `failed`;
 *   - a simulator-flagged result is REJECTED in production (fail closed) — the
 *     simulator can never impersonate real TallyPrime for a real customer;
 *   - timeout ⇒ the job is marked expired (best-effort) and the caller gets `timeout`.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@hisab/db';
import {
  connectorResultEnvelope,
  type ConnectorResultEnvelope,
  type TallyOperation,
} from '@hisab/shared';

const { tallyConnectors, tallyJobs } = schema;

/** Connector freshness bound: the poll loop touches last_seen_at every claim (≤ ~25s). */
export const CONNECTOR_STALE_MS = 90_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_POLL_MS = 400;

export interface ConnectorRow {
  id: string;
  name: string;
  status: string;
  lastSeenAt: Date | null;
  connectorVersion: string | null;
}

export type DispatchOutcome =
  | { kind: 'ok'; envelope: ConnectorResultEnvelope; connectorId: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'timeout'; reason: string }
  | { kind: 'failed'; reason: string };

export interface DispatchDeps {
  db: Db;
  tenantId: string;
}

export interface DispatchOptions {
  timeoutMs?: number;
  pollMs?: number;
  correlationId?: string;
}

export const isConnectorStale = (lastSeenAt: Date | null, now = Date.now()): boolean =>
  lastSeenAt === null || now - lastSeenAt.getTime() > CONNECTOR_STALE_MS;

/** The tenant's single ACTIVE connector (newest wins if several were registered). */
export async function getActiveConnector(deps: DispatchDeps): Promise<ConnectorRow | null> {
  return withTenant(deps.db, deps.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: tallyConnectors.id,
        name: tallyConnectors.name,
        status: tallyConnectors.status,
        lastSeenAt: tallyConnectors.lastSeenAt,
        connectorVersion: tallyConnectors.connectorVersion,
      })
      .from(tallyConnectors)
      .where(and(eq(tallyConnectors.tenantId, deps.tenantId), eq(tallyConnectors.status, 'active')))
      .orderBy(desc(tallyConnectors.createdAt))
      .limit(1);
    return row ?? null;
  });
}

/** True only in non-production, or when explicitly allowed (staging rehearsal). */
export const simulatorResultsAllowed = (env = process.env): boolean =>
  env['NODE_ENV'] !== 'production' || env['TALLY_ALLOW_SIMULATOR'] === '1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Queue one allowlisted operation for the tenant's connector and wait for its result.
 * Never throws for operational failures — every path is an explicit outcome the tool
 * layer maps onto the trust contract.
 */
export async function dispatchToConnector(
  deps: DispatchDeps,
  operation: TallyOperation,
  params: Record<string, unknown>,
  opts: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const connector = await getActiveConnector(deps);
  if (!connector) {
    return {
      kind: 'unavailable',
      reason: 'No TallyPrime connector is set up for this business yet.',
    };
  }
  if (isConnectorStale(connector.lastSeenAt)) {
    return {
      kind: 'unavailable',
      reason:
        'The TallyPrime connector has not checked in recently — the machine running Tally ' +
        'may be off or offline.',
    };
  }

  const [job] = await withTenant(deps.db, deps.tenantId, (tx) =>
    tx
      .insert(tallyJobs)
      .values({
        tenantId: deps.tenantId,
        connectorId: connector.id,
        operation,
        params,
        ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
      })
      .returning({ id: tallyJobs.id }),
  );
  if (!job) return { kind: 'failed', reason: 'could not queue the Tally job' };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const [row] = await withTenant(deps.db, deps.tenantId, (tx) =>
      tx
        .select({ status: tallyJobs.status, result: tallyJobs.result, error: tallyJobs.error })
        .from(tallyJobs)
        .where(eq(tallyJobs.id, job.id)),
    );
    if (!row) return { kind: 'failed', reason: 'job row disappeared' };
    if (row.status === 'queued' || row.status === 'running') continue;
    if (row.status === 'failed' || row.status === 'expired') {
      return { kind: 'failed', reason: row.error ?? `job ${row.status}` };
    }
    // done — validate the envelope before ANY figure can travel further
    const parsed = connectorResultEnvelope.safeParse(row.result);
    if (!parsed.success) {
      return { kind: 'failed', reason: 'connector result failed schema validation' };
    }
    if (parsed.data.simulator && !simulatorResultsAllowed()) {
      return {
        kind: 'failed',
        reason: 'simulator-sourced result rejected in production (fail closed)',
      };
    }
    if (!parsed.data.ok) {
      return { kind: 'failed', reason: parsed.data.error ?? 'Tally operation failed' };
    }
    return { kind: 'ok', envelope: parsed.data, connectorId: connector.id };
  }

  // Timed out. Best-effort: mark it expired so a late connector result is inert
  // (only a still-queued/running job flips; a done row is left as-is for audit).
  await withTenant(deps.db, deps.tenantId, (tx) =>
    tx
      .update(tallyJobs)
      .set({ status: 'expired', finishedAt: sql`now()` })
      .where(and(eq(tallyJobs.id, job.id), sql`${tallyJobs.status} IN ('queued','running')`)),
  ).catch(() => undefined);
  return {
    kind: 'timeout',
    reason: 'TallyPrime did not answer in time — is Tally open with the company loaded?',
  };
}
