/**
 * Connector-facing API core (transport-agnostic; http.ts wires the routes).
 *
 * The customer-side connector ONLY dials out: it registers once with a short-lived
 * setup code the owner got on WhatsApp, then long-polls for jobs with its device
 * token. Runs on the CROSS-TENANT hisab_orch handle (token → tenant lookup), exactly
 * like the payments return-URL callback; every job row it touches is still bound to
 * the connector's own tenant by construction.
 *
 * Token hygiene: the device token is 32 random bytes, shown ONCE to the connector at
 * registration; only its SHA-256 hex is stored. A revoked connector's token dies with
 * the row's status.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import { connectorResultEnvelope, isTallyOperation } from '@hisab/shared';

const { tallyConnectors, tallyJobs } = schema;

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Setup codes avoid ambiguous glyphs (0/O, 1/I/L) — the owner types this by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SETUP_CODE_TTL_MS = 15 * 60 * 1000;

export function newSetupCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export interface RegisterInput {
  setup_code: string;
  connector_version?: string;
}

export type RegisterOutcome =
  | { kind: 'registered'; connectorId: string; connectorToken: string }
  | { kind: 'invalid_code' };

/** Swap a live setup code for a device token (single-use, expiring, atomic). */
export async function registerConnector(db: Db, input: RegisterInput): Promise<RegisterOutcome> {
  const token = randomBytes(32).toString('hex');
  const code = input.setup_code.trim().toUpperCase();
  if (!code) return { kind: 'invalid_code' };
  // One UPDATE is the whole exchange: only a pending, unexpired row with this exact
  // code flips to active — a raced/duplicate registration finds no row and fails.
  const rows = await db
    .update(tallyConnectors)
    .set({
      status: 'active',
      tokenHash: hashToken(token),
      setupCode: null,
      setupCodeExpiresAt: null,
      lastSeenAt: sql`now()`,
      ...(input.connector_version ? { connectorVersion: input.connector_version } : {}),
    })
    .where(
      and(
        eq(tallyConnectors.setupCode, code),
        eq(tallyConnectors.status, 'pending'),
        sql`${tallyConnectors.setupCodeExpiresAt} > now()`,
      ),
    )
    .returning({ id: tallyConnectors.id });
  const row = rows[0];
  if (!row) return { kind: 'invalid_code' };
  return { kind: 'registered', connectorId: row.id, connectorToken: token };
}

export interface AuthedConnector {
  id: string;
  tenantId: string;
}

/** Device-token auth + heartbeat: every authenticated call refreshes last_seen_at. */
export async function authConnector(
  db: Db,
  bearerToken: string,
  connectorVersion?: string,
): Promise<AuthedConnector | null> {
  if (!bearerToken) return null;
  const rows = await db
    .update(tallyConnectors)
    .set({
      lastSeenAt: sql`now()`,
      ...(connectorVersion ? { connectorVersion } : {}),
    })
    .where(
      and(
        eq(tallyConnectors.tokenHash, hashToken(bearerToken)),
        eq(tallyConnectors.status, 'active'),
      ),
    )
    .returning({ id: tallyConnectors.id, tenantId: tallyConnectors.tenantId });
  const row = rows[0];
  return row ? { id: row.id, tenantId: row.tenantId } : null;
}

export interface ClaimedJob {
  id: string;
  operation: string;
  params: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Long-poll claim: hand the connector its oldest queued job, atomically flipping it
 * to running (FOR UPDATE SKIP LOCKED — two claims can never win the same job). Waits
 * up to `waitMs` before answering "nothing to do".
 */
export async function claimJob(
  db: Db,
  connectorId: string,
  waitMs = 20_000,
  pollMs = 500,
): Promise<ClaimedJob | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rows = await db
      .update(tallyJobs)
      .set({ status: 'running', claimedAt: sql`now()` })
      .where(
        sql`${tallyJobs.id} = (
          SELECT id FROM tally_jobs
          WHERE connector_id = ${connectorId} AND status = 'queued'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )`,
      )
      .returning({ id: tallyJobs.id, operation: tallyJobs.operation, params: tallyJobs.params });
    const row = rows[0];
    if (row) return row;
    if (Date.now() + pollMs > deadline) return null;
    await sleep(pollMs);
  }
}

export type ResultOutcome = 'stored' | 'unknown_job';

/**
 * Store a connector's result for a job IT owns and is still running. The envelope is
 * schema-validated here (reject early, keep garbage out of the DB); the tool layer
 * re-validates on read (defense in depth). An expired/foreign job is refused.
 */
export async function postResult(
  db: Db,
  connectorId: string,
  jobId: string,
  envelope: unknown,
): Promise<ResultOutcome> {
  const parsed = connectorResultEnvelope.safeParse(envelope);
  if (!parsed.success || !isTallyOperation(parsed.data.op)) return 'unknown_job';
  const rows = await db
    .update(tallyJobs)
    .set({
      status: parsed.data.ok ? 'done' : 'failed',
      result: parsed.data,
      ...(parsed.data.ok ? {} : { error: parsed.data.error ?? 'connector reported failure' }),
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(tallyJobs.id, jobId),
        eq(tallyJobs.connectorId, connectorId),
        eq(tallyJobs.status, 'running'),
      ),
    )
    .returning({ id: tallyJobs.id });
  return rows[0] ? 'stored' : 'unknown_job';
}
