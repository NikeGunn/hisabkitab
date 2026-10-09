/**
 * LangSmith Datasets + Experiments (patterns from the langsmith-dataset and
 * langsmith-evaluator skills), wired to OUR deterministic judge.
 *
 *   syncDataset('dev')         → dataset "hisab-rehearsal-<version>-dev" (one example per scenario)
 *   runExperiment(agent, 'dev') → LangSmith Experiment: every episode traced,
 *                                 every example scored, agents comparable side-by-side
 *
 * Evaluators are CODE, not an LLM judge: they read the verdict our judge already
 * produced, plus one independent cross-check (`reference_match`) that recomputes
 * the outcome from LangSmith's stored reference outputs. If those two ever
 * disagree, the judge or the dataset has drifted — a cheap tripwire.
 *
 * The TEST split is never uploaded (contamination guard).
 */
import { Client } from 'langsmith';
import { evaluate, type EvaluatorT } from 'langsmith/evaluation';
import { makeAgent } from '../agents/registry.js';
import { ENV_VERSION } from '../env/environment.js';
import { JUDGE_VERSION, type Verdict } from '../judge/judge.js';
import { runEpisode } from '../runner/episode.js';
import { DATASET_VERSION, datasetHash, scenariosFor } from '../scenarios/catalog.js';
import type { ExpectedEntry } from '../scenarios/types.js';

export type UploadableSplit = 'train' | 'dev';

export const datasetName = (split: UploadableSplit) => `hisab-rehearsal-${DATASET_VERSION}-${split}`;

export async function syncDataset(split: UploadableSplit, client = new Client()): Promise<{ name: string; created: boolean; examples: number }> {
  const name = datasetName(split);
  if (await client.hasDataset({ datasetName: name })) return { name, created: false, examples: scenariosFor(split).length };
  const ds = await client.createDataset(name, {
    description: `HisabKitab rehearsal scenarios (${split} split, ${DATASET_VERSION}, sha256 ${datasetHash().slice(0, 12)}). Synthetic data only.`,
    metadata: { dataset_version: DATASET_VERSION, split },
  });
  const scenarios = scenariosFor(split);
  await client.createExamples(
    scenarios.map((s) => ({
      dataset_id: ds.id,
      inputs: { scenario_id: s.id, family: s.family, difficulty: s.difficulty, first_message: s.owner_script[0]?.say ?? '' },
      outputs: {
        expected_confirmed: s.oracle.expected_confirmed,
        must_clarify_before_draft: s.oracle.must_clarify_before_draft,
        must_decline: s.oracle.must_decline,
        rubric: s.oracle.rubric,
      },
      metadata: { family: s.family, difficulty: s.difficulty },
      split,
    })),
  );
  return { name, created: true, examples: scenarios.length };
}

interface TargetOutput {
  verdict: Verdict;
  confirmed: ExpectedEntry[];
  messages: string[];
}

/** Score keys shown as columns in the LangSmith Experiment table. */
const fromVerdict =
  (key: string, pick: (v: Verdict) => number, comment?: (v: Verdict) => string): EvaluatorT =>
  ({ outputs }: { outputs: Record<string, unknown> }) => {
    const v = (outputs as unknown as TargetOutput).verdict;
    return { key, score: pick(v), ...(comment ? { comment: comment(v) } : {}) };
  };

const EVALUATORS: EvaluatorT[] = [
  fromVerdict('passed', (v) => (v.passed ? 1 : 0), (v) => v.failure_class),
  fromVerdict('reward', (v) => v.reward),
  fromVerdict('safety', (v) => (v.hard.length === 0 ? 1 : 0), (v) => v.hard.map((h) => `${h.code}: ${h.detail}`).join('; ') || 'no hard violation'),
  fromVerdict('outcome', (v) => v.outcome.score),
  fromVerdict('trajectory', (v) => v.trajectory.score, (v) => v.trajectory.checks.filter((c) => !c.passed).map((c) => c.name).join(', ') || 'all checks passed'),
  // Independent tripwire: recompute "exactly the right entries were saved" from LangSmith's
  // stored reference outputs, and check the judge reached the same conclusion.
  ({ outputs, referenceOutputs }: { outputs: Record<string, unknown>; referenceOutputs?: Record<string, unknown> }) => {
    const key = (e: ExpectedEntry) => `${e.type}|${e.total_paisa}|${e.taxable_paisa}|${e.vat_paisa}`;
    const want = ((referenceOutputs?.['expected_confirmed'] as ExpectedEntry[] | undefined) ?? []).map(key).sort();
    const out = outputs as unknown as TargetOutput;
    const exact = JSON.stringify(want) === JSON.stringify(out.confirmed.map(key).sort());
    const judgeSaysExact = out.verdict.outcome.score === 1;
    return {
      key: 'judge_consistent',
      score: exact === judgeSaysExact ? 1 : 0,
      comment: exact === judgeSaysExact ? 'judge and reference agree' : `DRIFT: reference exact=${exact}, judge outcome=${out.verdict.outcome.score}`,
    };
  },
];

export async function runExperiment(agentName: string, split: UploadableSplit, opts: { maxConcurrency?: number } = {}): Promise<{ experimentName: string }> {
  const { name } = await syncDataset(split);
  const probe = makeAgent(agentName);
  const res = await evaluate(
    async (inputs: Record<string, unknown>): Promise<TargetOutput> => {
      const ep = await runEpisode(makeAgent(agentName), String(inputs['scenario_id']));
      return {
        verdict: ep.verdict,
        confirmed: ep.verdict.outcome.actual,
        messages: ep.events.filter((e) => e.kind === 'agent_message').map((e) => String(e.data['text'])),
      };
    },
    {
      data: name,
      evaluators: EVALUATORS,
      experimentPrefix: agentName.replace(/[^a-z0-9:-]/gi, '_'),
      description: `${probe.version} on ${name}`,
      metadata: { agent: agentName, agent_version: probe.version, env_version: ENV_VERSION, judge_version: JUDGE_VERSION, dataset_version: DATASET_VERSION },
      maxConcurrency: opts.maxConcurrency ?? 4,
    },
  );
  return { experimentName: res.experimentName };
}
