/** Save an in-process evaluation (pnpm lab eval --save) to the lab DB, same shape the worker writes. */
import type postgres from 'postgres';
import type { EvalReport } from '../experiment/evaluate.js';
import { ENV_VERSION } from '../env/environment.js';
import { JUDGE_VERSION } from '../judge/judge.js';
import { appendEvents, GENESIS, labDb } from './db.js';

export async function persistReport(report: EvalReport, experiment: string, sql: postgres.Sql = labDb()): Promise<string> {
  const split = report.cases[0]?.split ?? 'mixed';
  const { cases, ...summary } = report;
  const runId = await sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      INSERT INTO rehearsal.runs (experiment, agent, agent_version, split, dataset_version, dataset_hash, env_version, judge_version, status, summary, completed_at)
      VALUES (${experiment}, ${report.agent}, ${report.agent_version}, ${split}, ${report.dataset_version}, ${report.dataset_hash},
              ${ENV_VERSION}, ${JUDGE_VERSION}, 'completed', ${tx.json(summary as unknown as postgres.JSONValue)}, now())
      RETURNING id`;
    for (const c of cases) {
      const v = c.episode.verdict;
      const [ep] = await tx<{ id: string }[]>`
        INSERT INTO rehearsal.episodes (run_id, scenario_id, family, split, status, attempt, passed, reward, failure_class, hard, steps,
                                        input_tokens, output_tokens, cost_paisa, verdict, langsmith_run_id)
        VALUES (${run!.id}, ${c.scenario_id}, ${c.family}, ${c.split}, 'completed', 1, ${c.passed}, ${c.reward}, ${c.failure_class}, ${c.hard},
                ${c.steps}, ${c.input_tokens}, ${c.output_tokens}, ${c.cost_paisa}, ${tx.json(v as unknown as postgres.JSONValue)}, ${c.langsmith_run_id})
        RETURNING id`;
      await appendEvents(tx, ep!.id, c.episode.events, GENESIS, 1);
    }
    return run!.id;
  });
  await sql.end({ timeout: 5 });
  return runId;
}
