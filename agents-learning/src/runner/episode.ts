/**
 * Run one agent through one scenario, in memory. The durable worker (worker.ts)
 * wraps this same loop with checkpoints + leases; tests and the RL bridge use it
 * directly.
 */
import type { Action, LabEvent, Observation } from '../contracts.js';
import { RehearsalEnv, type EnvOptions } from '../env/environment.js';
import type { Verdict } from '../judge/judge.js';
import type { Agent, DecisionUsage } from '../agents/types.js';
import { span } from '../telemetry/langsmith.js';

export interface StepRecord {
  step: number;
  observation: Observation;
  action: Action;
  reward: number;
  note?: string;
  usage?: DecisionUsage;
  latency_ms: number;
  events: LabEvent[];
}

export interface EpisodeResult {
  scenario_id: string;
  agent: string;
  agent_version: string;
  verdict: Verdict;
  steps: StepRecord[];
  events: LabEvent[];
  usage: { input_tokens: number; output_tokens: number };
  state_digest: string;
}

export type Decision = Awaited<ReturnType<Agent['act']>>;

export interface EpisodeHooks {
  /**
   * Write-ahead: called AFTER the agent decided but BEFORE the env executes it.
   * The durable runner checkpoints the decision here, so a crash never re-asks
   * (re-pays) the model for a decision it already made.
   */
  onDecision?(decision: Decision): Promise<void> | void;
  /** Called after every executed step — the durable runner commits here. */
  onStep?(rec: StepRecord, env: RehearsalEnv): Promise<void> | void;
  now?(): number;
  /** Environment options (default: production parity, guards ON). */
  env?: EnvOptions;
}

export async function runEpisode(agent: Agent, scenarioId: string, hooks: EpisodeHooks = {}): Promise<EpisodeResult> {
  const env = new RehearsalEnv(hooks.env);
  const [first] = env.reset({ scenario_id: scenarioId });
  agent.begin(scenarioId);
  return continueEpisode(env, agent, first, [], hooks);
}

/** Drive an already-reset (or restored) env to the end. */
export async function continueEpisode(
  env: RehearsalEnv,
  agent: Agent,
  obs0: Observation,
  prior: StepRecord[],
  hooks: EpisodeHooks = {},
  /** A decision recovered from a checkpoint: executed first, without asking the agent again. */
  recovered?: Decision,
): Promise<EpisodeResult> {
  const now = hooks.now ?? (() => performance.now());
  const steps = [...prior];
  let obs = obs0;
  let pending = recovered;
  while (!env.state.done) {
    const t0 = now();
    const n = env.state.step + 1;
    // Spans are no-ops unless the episode runs inside a LangSmith trace (traceEpisode).
    const decision = pending ?? (await span(`step ${n} · agent.decide`, 'chain', { observation: obs }, () => agent.act(obs)));
    if (!pending) await hooks.onDecision?.(decision);
    pending = undefined;
    const a = decision.action;
    const [next, reward, , , info] = await span(
      `step ${n} · env.${a.type === 'tool' ? a.name : a.type}`,
      a.type === 'tool' ? 'tool' : 'chain',
      { action: a },
      () => env.step(a),
    );
    const rec: StepRecord = {
      step: env.state.step,
      observation: obs,
      action: decision.action,
      reward,
      latency_ms: Math.round(now() - t0),
      events: info.events,
      ...(decision.note ? { note: decision.note } : {}),
      ...(decision.usage ? { usage: decision.usage } : {}),
    };
    steps.push(rec);
    await hooks.onStep?.(rec, env);
    obs = next;
  }
  const verdict = env.state.verdict;
  if (!verdict) throw new Error('episode ended without a verdict');
  return {
    scenario_id: env.state.scenario_id,
    agent: agent.id,
    agent_version: agent.version,
    verdict,
    steps,
    events: [...env.state.events],
    usage: steps.reduce(
      (u, s) => ({ input_tokens: u.input_tokens + (s.usage?.input_tokens ?? 0), output_tokens: u.output_tokens + (s.usage?.output_tokens ?? 0) }),
      { input_tokens: 0, output_tokens: 0 },
    ),
    state_digest: env.snapshot().digest,
  };
}

/** Money spent by the agent in this episode (sum of per-decision costs; 0 for scripted agents). */
export const episodeCost = (ep: Pick<EpisodeResult, 'steps'>): number =>
  Math.ceil(ep.steps.reduce((sum, s) => sum + (s.usage?.cost_paisa ?? 0), 0));
