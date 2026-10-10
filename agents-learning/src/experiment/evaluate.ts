/**
 * Evaluate one policy on a scenario set, and compare two policies on the SAME set.
 *
 * Budget is a hard stop, not a hope: before each episode the runner checks the
 * money already spent; past the cap it stops and marks the report `partial`.
 */
import type { Agent } from '../agents/types.js';
import { ENV_VERSION } from '../env/environment.js';
import { JUDGE_VERSION } from '../judge/judge.js';
import { episodeCost, runEpisode, type EpisodeResult } from '../runner/episode.js';
import { DATASET_VERSION, datasetHash } from '../scenarios/catalog.js';
import type { Scenario } from '../scenarios/types.js';
import { flushTraces, traceEpisode } from '../telemetry/langsmith.js';
import { releaseGate, wilson, type GateResult } from '@hisab/shared';

export interface CaseResult {
  scenario_id: string;
  family: string;
  split: string;
  passed: boolean;
  reward: number;
  failure_class: string;
  hard: string[];
  steps: number;
  input_tokens: number;
  output_tokens: number;
  cost_paisa: number;
  langsmith_run_id: string | null;
  episode: EpisodeResult;
}

export interface EvalReport {
  agent: string;
  agent_version: string;
  dataset_version: string;
  dataset_hash: string;
  env_version: string;
  judge_version: string;
  n: number;
  partial: boolean;
  pass_rate: number;
  pass_ci95: { low: number; high: number };
  mean_reward: number;
  hard_violations: number;
  cost_paisa: number;
  by_family: Record<string, { n: number; passed: number }>;
  failure_classes: Record<string, number>;
  cases: CaseResult[];
}

export interface EvalOptions {
  budgetPaisa?: number;
  experiment?: string;
  onCase?(c: CaseResult): void | Promise<void>;
  /** Environment options (default: production parity, guards ON). */
  env?: import('../env/environment.js').EnvOptions;
}

export async function evaluate(makeAgent: () => Agent, scenarios: Scenario[], opts: EvalOptions = {}): Promise<EvalReport> {
  const budget = opts.budgetPaisa ?? Number.POSITIVE_INFINITY;
  const cases: CaseResult[] = [];
  let spent = 0;
  let partial = false;
  let agent = makeAgent();

  for (const s of scenarios) {
    if (spent >= budget) {
      partial = true;
      break;
    }
    agent = makeAgent();
    const ep = await traceEpisode(
      {
        scenario_id: s.id,
        family: s.family,
        split: s.split,
        agent: agent.id,
        agent_version: agent.version,
        dataset_version: DATASET_VERSION,
        env_version: ENV_VERSION,
        judge_version: JUDGE_VERSION,
        ...(opts.experiment ? { experiment: opts.experiment } : {}),
      },
      () => runEpisode(agent, s.id, opts.env ? { env: opts.env } : {}),
    );
    const cost = episodeCost(ep);
    spent += cost;
    const c: CaseResult = {
      scenario_id: s.id,
      family: s.family,
      split: s.split,
      passed: ep.verdict.passed,
      reward: ep.verdict.reward,
      failure_class: ep.verdict.failure_class,
      hard: ep.verdict.hard.map((h) => h.code),
      steps: ep.verdict.steps,
      input_tokens: ep.usage.input_tokens,
      output_tokens: ep.usage.output_tokens,
      cost_paisa: cost,
      langsmith_run_id: ep.langsmith_run_id,
      episode: ep,
    };
    cases.push(c);
    await opts.onCase?.(c);
  }
  await flushTraces();
  return summarize(agent, cases, partial);
}

export function summarize(agent: Pick<Agent, 'id' | 'version'>, cases: CaseResult[], partial = false): EvalReport {
  const passed = cases.filter((c) => c.passed).length;
  const byFamily: EvalReport['by_family'] = {};
  const classes: Record<string, number> = {};
  for (const c of cases) {
    const f = (byFamily[c.family] ??= { n: 0, passed: 0 });
    f.n += 1;
    if (c.passed) f.passed += 1;
    classes[c.failure_class] = (classes[c.failure_class] ?? 0) + 1;
  }
  const n = cases.length;
  return {
    agent: agent.id,
    agent_version: agent.version,
    dataset_version: DATASET_VERSION,
    dataset_hash: datasetHash(),
    env_version: ENV_VERSION,
    judge_version: JUDGE_VERSION,
    n,
    partial,
    pass_rate: n ? round(passed / n) : 0,
    pass_ci95: wilson(passed, n),
    mean_reward: n ? round(cases.reduce((s, c) => s + c.reward, 0) / n) : 0,
    hard_violations: cases.reduce((s, c) => s + c.hard.length, 0),
    cost_paisa: cases.reduce((s, c) => s + c.cost_paisa, 0),
    by_family: byFamily,
    failure_classes: classes,
    cases,
  };
}

/** Pair the two reports by scenario and apply the ONE release-gate rule (@hisab/shared). */
export function compare(base: EvalReport, cand: EvalReport): GateResult {
  const asRun = (r: EvalReport) => ({ label: r.agent_version, dataset_hash: r.dataset_hash, complete: !r.partial, cases: r.cases });
  return releaseGate(asRun(base), asRun(cand));
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
