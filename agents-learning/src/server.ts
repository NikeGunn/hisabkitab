/**
 * Rehearsal Lab HTTP API (node:http, no framework).
 *
 *   GET  /healthz                         liveness
 *   GET  /rl/spec                         skills + features + dataset version
 *   GET  /rl/scenarios?split=train        scenario ids (oracle never exposed)
 *   POST /rl/reset   {scenario_id}        → {session, done, features}
 *   POST /rl/step    {session, skill}     → {done, features | verdict}
 *   POST /lab/training-runs               research layer reports a training run (bearer LAB_API_TOKEN)
 *
 * Binds 127.0.0.1 by default: the RL bridge is a local research tool, not a public API.
 * The hidden TEST split is NOT served to /rl (a trainer can't even ask for it).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { FEATURES, SKILLS } from './agents/skills.js';
import { RlSession } from './rl/session.js';
import { DATASET_VERSION, scenariosFor } from './scenarios/catalog.js';
import { ENV_VERSION } from './env/environment.js';
import { JUDGE_VERSION } from './judge/judge.js';
import { labDb } from './store/db.js';
import type postgres from 'postgres';

const MAX_SESSIONS = 5_000;
const sessions = new Map<string, RlSession>();
const trainable = new Set(scenariosFor('all').filter((s) => s.split !== 'test').map((s) => s.id));

const ResetBody = z.object({ scenario_id: z.string() });
const StepBody = z.object({ session: z.string().uuid(), skill: z.number().int().min(0).max(SKILLS.length - 1) });
const TrainingRunBody = z.object({
  name: z.string().min(1).max(200),
  algorithm: z.string().min(1).max(100),
  reward_version: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
  curve: z.array(z.record(z.string(), z.unknown())).max(10_000),
  evaluation: z.record(z.string(), z.unknown()),
});

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function authorized(req: IncomingMessage): boolean {
  const token = process.env['LAB_API_TOKEN'];
  if (!token) return false;
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createLabServer(db?: postgres.Sql) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, sessions: sessions.size });
      if (req.method === 'GET' && url.pathname === '/rl/spec') {
        return send(res, 200, { skills: SKILLS, features: FEATURES, dataset_version: DATASET_VERSION, env_version: ENV_VERSION, judge_version: JUDGE_VERSION });
      }
      if (req.method === 'GET' && url.pathname === '/rl/scenarios') {
        const split = url.searchParams.get('split') ?? 'train';
        if (split === 'test') return send(res, 403, { error: 'the test split is held out and never served to trainers' });
        return send(res, 200, { ids: scenariosFor(split as 'train' | 'dev').map((s) => s.id) });
      }
      if (req.method === 'POST' && url.pathname === '/rl/reset') {
        const { scenario_id } = ResetBody.parse(await readJson(req));
        if (!trainable.has(scenario_id)) return send(res, 403, { error: `${scenario_id} is not a train/dev scenario` });
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
        const id = randomUUID();
        const s = new RlSession(scenario_id);
        sessions.set(id, s);
        return send(res, 200, { session: id, ...s.reset() });
      }
      if (req.method === 'POST' && url.pathname === '/rl/step') {
        const { session, skill } = StepBody.parse(await readJson(req));
        const s = sessions.get(session);
        if (!s) return send(res, 404, { error: 'unknown or finished session' });
        const point = s.choose(skill);
        if (point.done) sessions.delete(session);
        return send(res, 200, point);
      }
      if (req.method === 'POST' && url.pathname === '/lab/training-runs') {
        if (!authorized(req)) return send(res, 401, { error: 'bearer LAB_API_TOKEN required' });
        if (!db) return send(res, 503, { error: 'LAB_DATABASE_URL not configured' });
        const b = TrainingRunBody.parse(await readJson(req));
        const [row] = await db<{ id: string }[]>`
          INSERT INTO rehearsal.training_runs (name, algorithm, reward_version, config, curve, evaluation)
          VALUES (${b.name}, ${b.algorithm}, ${b.reward_version}, ${db.json(b.config as postgres.JSONValue)},
                  ${db.json(b.curve as postgres.JSONValue)}, ${db.json(b.evaluation as postgres.JSONValue)})
          RETURNING id`;
        return send(res, 201, { id: row!.id });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : err instanceof Error ? err.message : String(err);
      return send(res, 400, { error: msg });
    }
  });
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const port = Number(process.env['PORT'] ?? 8820);
  const host = process.env['LAB_HOST'] ?? '127.0.0.1';
  const db = process.env['LAB_DATABASE_URL'] ? labDb() : undefined;
  createLabServer(db).listen(port, host, () => console.log(JSON.stringify({ msg: 'rehearsal lab listening', host, port, db: Boolean(db) })));
}
