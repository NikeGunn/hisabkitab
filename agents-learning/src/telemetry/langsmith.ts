/**
 * LangSmith tracing for rehearsal episodes (pattern from the langsmith-trace skill:
 * no framework ⇒ `traceable` + a wrapped LLM client).
 *
 *   rehearsal:<scenario>            run_type=chain   (one trace per episode)
 *     ├─ step 1 · agent.decide      run_type=chain   (wrapAnthropic LLM runs nest here)
 *     ├─ step 1 · env.<tool>        run_type=tool    (sandbox tool + its events)
 *     └─ …
 *   + feedback on the root run: reward, passed, outcome, trajectory, hard_violations
 *
 * Rules:
 *   - FAIL-OPEN: tracing errors are counted and swallowed; they never change an
 *     episode's actions or verdict. The Postgres event log is the source of truth;
 *     LangSmith is a viewer.
 *   - CONTAMINATION GUARD: the hidden TEST split is never exported (its bills and
 *     oracle must not live in a third-party system a future prompt could be tuned on).
 *   - OFF unless LANGSMITH_TRACING=true and LANGSMITH_API_KEY is set.
 */
import { Client } from 'langsmith';
import { getCurrentRunTree, traceable } from 'langsmith/traceable';
import type { Split } from '../contracts.js';
import type { Verdict } from '../judge/judge.js';

export function langsmithEnabled(): boolean {
  return process.env['LANGSMITH_TRACING'] === 'true' && Boolean(process.env['LANGSMITH_API_KEY']);
}

export const tracingStats = { exported_episodes: 0, skipped_test_split: 0, errors: 0 };

let client: Client | undefined;
const getClient = (): Client => (client ??= new Client());

export interface TraceMeta {
  scenario_id: string;
  family: string;
  split: Split;
  agent: string;
  agent_version: string;
  dataset_version: string;
  env_version: string;
  judge_version: string;
  run_id?: string;
  experiment?: string;
}

export const shouldExport = (split: Split): boolean => langsmithEnabled() && split !== 'test';

/** Run `fn` inside a LangSmith root trace (or plainly, when export is off). Returns the root run id. */
export async function traceEpisode<T extends { verdict: Verdict }>(
  meta: TraceMeta,
  fn: () => Promise<T>,
): Promise<T & { langsmith_run_id: string | null }> {
  if (!shouldExport(meta.split)) {
    if (langsmithEnabled()) tracingStats.skipped_test_split += 1;
    return { ...(await fn()), langsmith_run_id: null };
  }
  let rootId: string | null = null;
  const traced = traceable(
    async () => {
      rootId = getCurrentRunTree(true)?.id ?? null;
      const r = await fn();
      return r;
    },
    {
      name: `rehearsal:${meta.scenario_id}`,
      run_type: 'chain',
      client: getClient(),
      project_name: process.env['LANGSMITH_PROJECT'] ?? 'hisab-rehearsal',
      metadata: { ...meta },
      tags: ['rehearsal', meta.family, meta.split, meta.agent],
      processOutputs: (o: Record<string, unknown>) => {
        const v = (o as { verdict?: Verdict }).verdict;
        return v ? { passed: v.passed, reward: v.reward, failure_class: v.failure_class, verdict: v } : o;
      },
    },
  );
  const result = await traced();
  if (rootId) await attachVerdict(rootId, result.verdict);
  tracingStats.exported_episodes += 1;
  return { ...result, langsmith_run_id: rootId };
}

/** A child span (agent decision or env tool step) — no-op outside a trace. */
export async function span<T>(name: string, runType: 'chain' | 'tool', inputs: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
  if (!getCurrentRunTree(true)) return await fn();
  return await traceable(async (_inputs: Record<string, unknown>) => await fn(), { name, run_type: runType, client: getClient() })(inputs);
}

/** Judge verdict → LangSmith feedback (scores visible + filterable on every trace). */
async function attachVerdict(runId: string, v: Verdict): Promise<void> {
  const c = getClient();
  const fb: Array<[string, number, string?]> = [
    ['reward', v.reward],
    ['passed', v.passed ? 1 : 0, v.failure_class],
    ['outcome', v.outcome.score],
    ['trajectory', v.trajectory.score],
    ['hard_violations', v.hard.length, v.hard.map((h) => h.code).join(',') || undefined],
  ];
  for (const [key, score, comment] of fb) {
    try {
      await c.createFeedback(runId, key, { score, ...(comment ? { comment } : {}), feedbackSourceType: 'api' });
    } catch {
      tracingStats.errors += 1;
    }
  }
}

export async function flushTraces(): Promise<void> {
  if (!langsmithEnabled()) return;
  try {
    await getClient().awaitPendingTraceBatches();
  } catch {
    tracingStats.errors += 1;
  }
}
