/**
 * Durable episode worker. Survives kill -9 at any instant without losing work or
 * applying a step twice.
 *
 *   queued ──claim──▶ running ──(every step: commit)──▶ completed
 *                        │  lease expires (worker died)
 *                        └──────────▶ re-claimed by another worker, resumes from checkpoint
 *   attempt > MAX_ATTEMPTS ──▶ quarantined (needs a human)
 *
 * Three ideas carry the whole design:
 *  1. LEASE + FENCING TOKEN. Claiming bumps `lease_token`. Every commit says
 *     "WHERE lease_token = mine"; a zombie worker whose lease was taken over
 *     matches 0 rows and stops. No two workers can both advance an episode.
 *  2. ATOMIC STEP COMMIT. The step's events and the new checkpoint are written in
 *     ONE transaction. A crash lands either before (step re-executes from the old
 *     checkpoint — the env is pure, so that is safe) or after (step is done).
 *     There is no in-between, so the sandbox ledger is exactly-once by construction.
 *  3. WRITE-AHEAD DECISION. The agent's decision is checkpointed before it runs, so
 *     resuming never re-asks (and re-pays) the model; it executes the recorded choice.
 */
import type postgres from 'postgres';
import type { LabEvent } from '../contracts.js';
import { makeAgent } from '../agents/registry.js';
import { RehearsalEnv, ENV_VERSION, type EnvState } from '../env/environment.js';
import { JUDGE_VERSION } from '../judge/judge.js';
import { digest } from '../hash.js';
import { DATASET_VERSION, datasetHash, getScenario } from '../scenarios/catalog.js';
import type { Scenario } from '../scenarios/types.js';
import { summarize, type CaseResult } from '../experiment/evaluate.js';
import { continueEpisode, episodeCost, type Decision, type StepRecord } from './episode.js';
import { GENESIS, appendEvents } from '../store/db.js';

export const LEASE_SECONDS = Number(process.env['LAB_LEASE_SECONDS'] ?? 30);
/** Chaos knob: slow every step so a test can kill -9 the worker mid-episode. 0 in normal use. */
const STEP_DELAY_MS = Number(process.env['LAB_STEP_DELAY_MS'] ?? 0);
export const MAX_ATTEMPTS = 3;

interface Checkpoint {
  env: { state: EnvState; digest: string };
  agent: unknown;
  steps: StepRecord[];
  head: string;
  /** Decided but not yet executed (write-ahead). */
  pending: Decision | null;
}

export class LeaseLost extends Error {}

export async function enqueueRun(
  sql: postgres.Sql,
  opts: { agent: string; split: string; scenarios: Scenario[]; budgetPaisa: number },
): Promise<string> {
  const agent = makeAgent(opts.agent);
  return sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      INSERT INTO rehearsal.runs (experiment, agent, agent_version, split, dataset_version, dataset_hash, env_version, judge_version, budget_paisa)
      VALUES (${`${opts.agent}@${opts.split}`}, ${opts.agent}, ${agent.version}, ${opts.split}, ${DATASET_VERSION}, ${datasetHash()},
              ${ENV_VERSION}, ${JUDGE_VERSION}, ${opts.budgetPaisa})
      RETURNING id`;
    for (const s of opts.scenarios) {
      await tx`INSERT INTO rehearsal.episodes (run_id, scenario_id, family, split) VALUES (${run!.id}, ${s.id}, ${s.family}, ${s.split})`;
    }
    return run!.id;
  });
}

interface Claim {
  id: string;
  run_id: string;
  scenario_id: string;
  attempt: number;
  lease_token: number;
  checkpoint: Checkpoint | null;
  checkpoint_digest: string | null;
  agent: string;
  budget_paisa: number;
}

/** Claim the next queued episode, or one whose lease expired (its worker died). */
export async function claim(sql: postgres.Sql, workerId: string): Promise<Claim | null> {
  const rows = await sql<Claim[]>`
    UPDATE rehearsal.episodes e
       SET status = 'running', lease_owner = ${workerId},
           lease_until = now() + make_interval(secs => ${LEASE_SECONDS}),
           lease_token = e.lease_token + 1, attempt = e.attempt + 1, updated_at = now()
      FROM rehearsal.runs r
     WHERE r.id = e.run_id
       AND e.id = (SELECT id FROM rehearsal.episodes
                    WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
                    ORDER BY updated_at
                    LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING e.id, e.run_id, e.scenario_id, e.attempt, e.lease_token::int AS lease_token,
              e.checkpoint, e.checkpoint_digest, r.agent, r.budget_paisa::int AS budget_paisa`;
  const c = rows[0];
  if (!c) return null;
  if (c.attempt > MAX_ATTEMPTS) {
    await sql`UPDATE rehearsal.episodes SET status = 'quarantined', error = ${`gave up after ${MAX_ATTEMPTS} attempts`}, updated_at = now()
              WHERE id = ${c.id} AND lease_token = ${c.lease_token}`;
    return claim(sql, workerId);
  }
  return c;
}

export class SimulatedCrash extends Error {}

/** Run (or resume) one claimed episode to completion. `crashAfterSteps` is fault injection for tests. */
export async function runClaimed(sql: postgres.Sql, c: Claim, opts: { crashAfterSteps?: number } = {}): Promise<CaseResult> {
  const env = new RehearsalEnv();
  const agent = makeAgent(c.agent);
  let steps: StepRecord[] = [];
  let head = GENESIS;
  let pending: Decision | null = null;

  if (c.checkpoint) {
    if (digest(c.checkpoint) !== c.checkpoint_digest) {
      await quarantine(sql, c, 'checkpoint digest mismatch — refusing to resume from a corrupted checkpoint');
      throw new Error(`episode ${c.id} quarantined: corrupted checkpoint`);
    }
    env.restore(c.checkpoint.env); // also re-verifies the env-state digest
    agent.restore(c.checkpoint.agent);
    ({ steps, head, pending } = c.checkpoint);
  } else {
    const [, info] = env.reset({ scenario_id: c.scenario_id });
    agent.begin(c.scenario_id);
    head = await commit(sql, c, env, agent, [], head, null, info.events);
  }

  const result = await continueEpisode(
    env,
    agent,
    env.observe(),
    steps,
    {
      onDecision: async (d) => {
        await commit(sql, c, env, agent, steps, head, d, []);
      },
      onStep: async (rec) => {
        steps = [...steps, rec];
        head = await commit(sql, c, env, agent, steps, head, null, rec.events);
        if (STEP_DELAY_MS) await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
        if (opts.crashAfterSteps !== undefined && steps.length >= opts.crashAfterSteps) throw new SimulatedCrash(`crash after step ${steps.length}`);
      },
    },
    pending ?? undefined,
  );

  const cost = episodeCost(result);
  const v = result.verdict;
  const done = await sql`
    UPDATE rehearsal.episodes SET status = 'completed', passed = ${v.passed}, reward = ${v.reward}, failure_class = ${v.failure_class},
           hard = ${v.hard.map((h) => h.code)}, steps = ${v.steps}, input_tokens = ${result.usage.input_tokens},
           output_tokens = ${result.usage.output_tokens}, cost_paisa = ${cost}, verdict = ${sql.json(v as unknown as postgres.JSONValue)},
           lease_owner = NULL, lease_until = NULL, updated_at = now()
     WHERE id = ${c.id} AND lease_token = ${c.lease_token}`;
  if (done.count === 0) throw new LeaseLost(`lost lease on ${c.id} before completion`);
  await finalizeRunIfDone(sql, c.run_id);

  const s = getScenario(c.scenario_id);
  return {
    scenario_id: s.id,
    family: s.family,
    split: s.split,
    passed: v.passed,
    reward: v.reward,
    failure_class: v.failure_class,
    hard: v.hard.map((h) => h.code),
    steps: v.steps,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cost_paisa: cost,
    langsmith_run_id: null,
    episode: result,
  };
}

/** One transaction: new events (hash-chained) + new checkpoint + lease heartbeat, fenced by lease_token. */
async function commit(
  sql: postgres.Sql,
  c: Claim,
  env: RehearsalEnv,
  agent: ReturnType<typeof makeAgent>,
  steps: StepRecord[],
  head: string,
  pending: Decision | null,
  events: LabEvent[],
): Promise<string> {
  return sql.begin(async (tx) => {
    // Fence FIRST (row lock + ownership check), then write.
    const owned = await tx`SELECT 1 FROM rehearsal.episodes WHERE id = ${c.id} AND lease_token = ${c.lease_token} FOR UPDATE`;
    if (owned.length === 0) throw new LeaseLost(`episode ${c.id}: lease taken over by another worker`);
    const newHead = await appendEvents(tx, c.id, events, head, c.attempt);
    const cp: Checkpoint = { env: env.snapshot(), agent: agent.snapshot(), steps, head: newHead, pending };
    await tx`UPDATE rehearsal.episodes
                SET checkpoint = ${tx.json(cp as unknown as postgres.JSONValue)}, checkpoint_digest = ${digest(cp)},
                    lease_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
              WHERE id = ${c.id}`;
    return newHead;
  });
}

async function quarantine(sql: postgres.Sql, c: Claim, why: string): Promise<void> {
  await sql`UPDATE rehearsal.episodes SET status = 'quarantined', error = ${why}, updated_at = now() WHERE id = ${c.id} AND lease_token = ${c.lease_token}`;
}

/** When the last episode of a run finishes, write the run summary (idempotent). */
export async function finalizeRunIfDone(sql: postgres.Sql, runId: string): Promise<void> {
  const open = await sql`SELECT 1 FROM rehearsal.episodes WHERE run_id = ${runId} AND status IN ('queued', 'running') LIMIT 1`;
  if (open.length > 0) return;
  const [run] = await sql<{ agent: string; agent_version: string }[]>`SELECT agent, agent_version FROM rehearsal.runs WHERE id = ${runId}`;
  const rows = await sql<
    { scenario_id: string; family: string; split: string; passed: boolean; reward: number; failure_class: string; hard: string[]; steps: number; input_tokens: string; output_tokens: string; cost_paisa: string }[]
  >`SELECT scenario_id, family, split, passed, reward, failure_class, hard, steps, input_tokens, output_tokens, cost_paisa
      FROM rehearsal.episodes WHERE run_id = ${runId} AND status = 'completed' ORDER BY scenario_id`;
  const cases = rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cost_paisa: Number(r.cost_paisa), langsmith_run_id: null, episode: undefined as never }));
  const { cases: _drop, ...summary } = summarize({ id: run!.agent, version: run!.agent_version }, cases);
  void _drop;
  await sql`UPDATE rehearsal.runs SET status = 'completed', summary = ${sql.json(summary as unknown as postgres.JSONValue)}, completed_at = now()
             WHERE id = ${runId} AND status <> 'completed'`;
}

/** Worker loop: claim → run → repeat, until the queue is empty (or forever with `follow`). */
export async function workLoop(sql: postgres.Sql, workerId: string, opts: { follow?: boolean; log?: (s: string) => void } = {}): Promise<number> {
  const log = opts.log ?? ((s: string) => console.log(s));
  let done = 0;
  for (;;) {
    const c = await claim(sql, workerId);
    if (!c) {
      if (!opts.follow) return done;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    log(`[${workerId}] ${c.checkpoint ? 'RESUME' : 'start '} ${c.scenario_id} attempt ${c.attempt}${c.checkpoint ? ` from step ${c.checkpoint.env.state.step}` : ''}`);
    try {
      const r = await runClaimed(sql, c);
      done += 1;
      log(`[${workerId}] done   ${c.scenario_id} ${r.passed ? 'PASS' : r.failure_class}`);
    } catch (err) {
      if (err instanceof LeaseLost) log(`[${workerId}] LEASE LOST ${c.scenario_id} — another worker owns it now; stopping this copy`);
      else {
        log(`[${workerId}] ERROR ${c.scenario_id}: ${err instanceof Error ? err.message : String(err)}`);
        await sql`UPDATE rehearsal.episodes SET error = ${String(err).slice(0, 500)}, lease_until = now(), updated_at = now()
                   WHERE id = ${c.id} AND lease_token = ${c.lease_token} AND status = 'running'`;
      }
    }
  }
}
