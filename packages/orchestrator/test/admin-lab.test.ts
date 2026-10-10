/**
 * Admin → Agent Lab over the REAL Fastify server + REAL Postgres. PROBES: no session,
 * approving a FAIL gate (form tampering), XSS inside an agent message, a tampered event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { createDb, SettingsCache, type DbHandle } from '@hisab/db';
import { EVENT_CHAIN_GENESIS, eventHash } from '@hisab/shared';
import { buildServer } from '../src/server.js';
import { registerAdmin } from '../src/admin/routes.js';
import { AdminAuth, hashPassword } from '../src/admin/auth.js';
import type { RouterDeps } from '../src/whatsapp/router.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

const PASSWORD = 'lab panel password';
let orch: DbHandle;
let adminDb: DbHandle;
let app: FastifyInstance;
let settings: SettingsCache;
let baseline: string;
let candidate: string;
let episodeId: string;

async function seedRun(agent: string, passed: boolean, hard: string[]): Promise<string> {
  const [run] = (await adminDb.db.execute(sql`
    INSERT INTO rehearsal.runs (experiment, agent, agent_version, split, dataset_version, dataset_hash, env_version, judge_version, status, summary)
    VALUES (${agent}, ${agent}, ${agent + '-v1'}, 'dev', 'rehearsal-v1', 'hash-1', 'env', 'judge', 'completed',
            ${JSON.stringify({ pass_rate: passed ? 1 : 0, pass_ci95: { low: 0, high: 1 }, hard_violations: hard.length, cost_paisa: 0 })}::jsonb)
    RETURNING id`)) as unknown as Array<{ id: string }>;
  const [ep] = (await adminDb.db.execute(sql`
    INSERT INTO rehearsal.episodes (run_id, scenario_id, family, split, status, attempt, passed, reward, failure_class, hard, steps, verdict)
    VALUES (${run!.id}, 'bill_extraction/000', 'bill_extraction', 'dev', 'completed', 1, ${passed}, ${passed ? 1 : -1},
            ${passed ? 'PASS' : 'UNAPPROVED_SAVE'}, ${'{' + hard.join(',') + '}'}::text[], 4,
            ${JSON.stringify({ hard: hard.map((code) => ({ code, detail: 'saved without a yes' })), outcome: { score: 1, expected: [], actual: [] }, trajectory: { score: 1, checks: [] } })}::jsonb)
    RETURNING id`)) as unknown as Array<{ id: string }>;
  const events = [
    { seq: 0, kind: 'owner_message', data: { text: 'Add this bill <script>alert(1)</script>' } },
    { seq: 1, kind: 'ledger_write', data: { op: 'confirm', entry_type: 'expense', total_paisa: 850000, owner_approved: passed } },
  ];
  let prev = EVENT_CHAIN_GENESIS;
  for (const e of events) {
    const hash = eventHash(prev, e);
    await adminDb.db.execute(sql`INSERT INTO rehearsal.events (episode_id, seq, kind, data, prev_hash, hash)
      VALUES (${ep!.id}, ${e.seq}, ${e.kind}, ${JSON.stringify(e.data)}::jsonb, ${prev}, ${hash})`);
    prev = hash;
  }
  episodeId = ep!.id;
  return run!.id;
}

beforeAll(async () => {
  orch = createDb(ORCH_URL, 2);
  adminDb = createDb(ADMIN_URL, 2);
  settings = await new SettingsCache(orch.db, {}).start(60_000);
  const auth = new AdminAuth('signing-secret-lab', await hashPassword(PASSWORD));
  app = buildServer({
    verifyToken: () => 'x',
    appSecret: () => 'x',
    acceptsPhoneNumberId: () => false,
    awaitProcessing: true,
    deps: {} as RouterDeps,
    register: (s) =>
      registerAdmin(s, {
        db: orch.db,
        settings,
        auth,
        sendAuthCode: async () => undefined,
        sendTemplate: async () => undefined,
        signingSecret: 'signing-secret-lab',
        agentConfigured: false,
        model: 'claude-test',
        diskUsage: async () => null,
      }),
  });
  baseline = await seedRun('careful', true, []);
  candidate = await seedRun('eager', false, ['UNAPPROVED_SAVE']);
});

afterAll(async () => {
  await adminDb.db.execute(sql`TRUNCATE rehearsal.training_runs, rehearsal.release_decisions, rehearsal.events, rehearsal.episodes, rehearsal.runs`);
  settings.stop();
  await app.close();
  await orch.close();
  await adminDb.close();
});

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/admin/login', headers: FORM, payload: form({ password: PASSWORD }) });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const page = await app.inject({ url: '/admin/lab/release', headers: { cookie } });
  return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(page.body)![1]! };
}

describe('admin Agent Lab', () => {
  it('PROBE: every lab page needs an admin session', async () => {
    for (const url of ['/admin/lab', `/admin/lab/runs/${baseline}`, `/admin/lab/episodes/${episodeId}`, '/admin/lab/release']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin/login');
    }
  });

  it('overview, run and episode pages render real data; the event chain verifies', async () => {
    const s = await login();
    const overview = await app.inject({ url: '/admin/lab', headers: { cookie: s.cookie } });
    expect(overview.body).toContain('careful-v1');
    expect(overview.body).toContain('eager-v1');
    const run = await app.inject({ url: `/admin/lab/runs/${candidate}`, headers: { cookie: s.cookie } });
    expect(run.body).toContain('UNAPPROVED_SAVE');
    const ep = await app.inject({ url: `/admin/lab/episodes/${episodeId}`, headers: { cookie: s.cookie } });
    expect(ep.body).toContain('intact (2 events)');
    expect(ep.body).toContain('NOT approved by owner');
  });

  it('training card: empty state tells how to import; an imported run shows dev + held-out test', async () => {
    const s = await login();
    await adminDb.db.execute(sql`TRUNCATE rehearsal.training_runs`);
    const empty = await app.inject({ url: '/admin/lab', headers: { cookie: s.cookie } });
    expect(empty.body).toContain('vm-lab.sh import-training');
    const [t] = (await adminDb.db.execute(sql`
      INSERT INTO rehearsal.training_runs (name, algorithm, reward_version, config, curve, evaluation)
      VALUES ('grpo-v1_judge-seed0', 'grpo', 'v1_judge', '{}'::jsonb,
              ${JSON.stringify([{ mean_judge_reward: 0.1, pass_rate: 0.1, hard_violation_rate: 0.2 }, { mean_judge_reward: 0.8, pass_rate: 0.83, hard_violation_rate: 0 }])}::jsonb,
              ${JSON.stringify({ dev_before: { pass_rate: 0.25, hard: 0 }, dev_after: { pass_rate: 0.83, hard: 0 }, test: { pass_rate: 0.8333, hard: 0, n: 24 } })}::jsonb)
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const page = await app.inject({ url: '/admin/lab', headers: { cookie: s.cookie } });
    expect(page.body).toContain('grpo-v1_judge-seed0');
    expect(page.body).toContain('83.3%');
    expect(page.body).toContain('n=24');
    const detail = await app.inject({ url: `/admin/lab/training/${t!.id}`, headers: { cookie: s.cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('Held-out TEST');
    expect(detail.body).toContain('<svg');
  });

  it('PROBE: agent/owner text is escaped (no stored XSS from a trajectory)', async () => {
    const s = await login();
    const ep = await app.inject({ url: `/admin/lab/episodes/${episodeId}`, headers: { cookie: s.cookie } });
    expect(ep.body).not.toContain('<script>alert(1)</script>');
    expect(ep.body).toContain('&#60;script&#62;');
  });

  it('PROBE: a tampered event breaks the chain and the page says so', async () => {
    await adminDb.db.execute(sql`UPDATE rehearsal.events SET data = '{"op":"confirm","owner_approved":true}'::jsonb WHERE episode_id = ${episodeId} AND seq = 1`);
    const s = await login();
    const ep = await app.inject({ url: `/admin/lab/episodes/${episodeId}`, headers: { cookie: s.cookie } });
    expect(ep.body).toContain('BROKEN at seq 1');
  });

  it('release review: the gate FAILS a candidate with a hard violation', async () => {
    const s = await login();
    const res = await app.inject({ url: `/admin/lab/release?baseline=${baseline}&candidate=${candidate}`, headers: { cookie: s.cookie } });
    expect(res.body).toContain('hard safety violation');
    expect(res.body).toMatch(/disabled title="Only a PASS gate can be approved"/);
  });

  it('PROBE: forging an "approved" POST for a FAIL gate is refused server-side', async () => {
    const s = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/lab/release',
      headers: { ...FORM, cookie: s.cookie },
      payload: form({ _csrf: s.csrf, baseline, candidate, decision: 'approved', reason: 'ship it' }),
    });
    expect(res.statusCode).toBe(303);
    expect(String(res.headers.location)).toContain('Cannot+approve');
    const rows = (await adminDb.db.execute(sql`SELECT count(*)::int AS n FROM rehearsal.release_decisions`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });

  it('a rejection is recorded with the reason and audited', async () => {
    const s = await login();
    await app.inject({
      method: 'POST',
      url: '/admin/lab/release',
      headers: { ...FORM, cookie: s.cookie },
      payload: form({ _csrf: s.csrf, baseline, candidate, decision: 'rejected', reason: 'saves without asking' }),
    });
    const rows = (await adminDb.db.execute(sql`SELECT decision, gate, reason FROM rehearsal.release_decisions`)) as unknown as Array<Record<string, string>>;
    expect(rows).toEqual([{ decision: 'rejected', gate: 'FAIL', reason: 'saves without asking' }]);
    const audit = (await adminDb.db.execute(sql`SELECT count(*)::int AS n FROM admin_events WHERE action = 'lab.release.rejected'`)) as unknown as Array<{ n: number }>;
    expect(audit[0]!.n).toBe(1);
  });
});
