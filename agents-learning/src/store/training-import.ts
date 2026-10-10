/**
 * Import committed training results (research/results/*.json) into the lab DB so the
 * admin panel's "Policy training" card shows them.
 *
 * Why this exists: the Python trainer only wrote to the DB with `--report` + a running
 * lab server + LAB_API_TOKEN — a path never used in production, so the card stayed
 * empty although six runs were committed. This reads the same JSON the trainer writes.
 *
 * Idempotent: each file's SHA-256 is stored in config.content_sha256; a file already
 * imported is skipped. Optionally attaches the HELD-OUT test result of the saved
 * weights, measured here for free (local policy, no model call).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { z } from 'zod';

export const TrainingResult = z.object({
  name: z.string().min(1).max(200),
  algorithm: z.string().min(1).max(100),
  reward_version: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
  curve: z.array(z.record(z.string(), z.unknown())).max(10_000),
  evaluation: z.record(z.string(), z.unknown()),
});
export type TrainingResult = z.infer<typeof TrainingResult>;

export interface TestEval {
  pass_rate: number;
  ci95: [number, number];
  hard: number;
  n: number;
  env_version: string;
}

export interface ImportOutcome {
  file: string;
  name: string;
  status: 'imported' | 'skipped' | 'invalid';
  id?: string;
  detail?: string;
}

export async function importTrainingResults(
  sql: postgres.Sql,
  dir: string,
  testEval?: (weightsFile: string) => Promise<TestEval | undefined>,
): Promise<ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const f of files) {
    const raw = readFileSync(join(dir, f), 'utf8');
    const sha = createHash('sha256').update(raw).digest('hex');
    const parsed = TrainingResult.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      out.push({
        file: f,
        name: '?',
        status: 'invalid',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      });
      continue;
    }
    const r = parsed.data;
    const [dupe] = await sql<{ id: string }[]>`
      SELECT id FROM rehearsal.training_runs WHERE config->>'content_sha256' = ${sha} LIMIT 1`;
    if (dupe) {
      out.push({
        file: f,
        name: r.name,
        status: 'skipped',
        id: dupe.id,
        detail: 'already imported',
      });
      continue;
    }
    const weights =
      typeof r.evaluation['weights_file'] === 'string'
        ? (r.evaluation['weights_file'] as string)
        : undefined;
    const test = weights && testEval ? await testEval(weights) : undefined;
    const evaluation = { ...r.evaluation, ...(test ? { test } : {}) };
    const config = { ...r.config, content_sha256: sha, source_file: `research/results/${f}` };
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO rehearsal.training_runs (name, algorithm, reward_version, config, curve, evaluation)
      VALUES (${r.name}, ${r.algorithm}, ${r.reward_version}, ${sql.json(config as postgres.JSONValue)},
              ${sql.json(r.curve as postgres.JSONValue)}, ${sql.json(evaluation as postgres.JSONValue)})
      RETURNING id`;
    out.push({
      file: f,
      name: r.name,
      status: 'imported',
      id: row!.id,
      ...(test
        ? { detail: `test pass ${(test.pass_rate * 100).toFixed(1)}%, hard ${test.hard}` }
        : {}),
    });
  }
  return out;
}

/** Weights path as written by train.py ("agents-learning/research/weights/x.json") → agent spec. */
export function policyAgentFor(weightsFile: string, labRoot: string): string | undefined {
  const rel = weightsFile.replace(/^agents-learning\//, '');
  return existsSync(join(labRoot, rel)) ? `policy:${rel}` : undefined;
}
