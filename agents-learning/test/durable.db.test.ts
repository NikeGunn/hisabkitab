/**
 * Durable runner + isolation against a real Postgres (migrations applied).
 *   LAB_TEST_DATABASE_URL        postgres://hisab_lab:…   (the least-privilege lab role)
 *   LAB_TEST_ADMIN_DATABASE_URL  postgres://postgres:…    (only to reset tables between tests)
 * Skipped when unset (CI sets both).
 */
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { claim, enqueueRun, LeaseLost, runClaimed, SimulatedCrash, workLoop } from '../src/runner/worker.js';
import { getScenario, goldenSet } from '../src/scenarios/catalog.js';
import { verifyChain } from '../src/store/db.js';
import { digest } from '../src/hash.js';

const LAB = process.env['LAB_TEST_DATABASE_URL'];
const ADMIN = process.env['LAB_TEST_ADMIN_DATABASE_URL'];
const run = LAB && ADMIN ? describe : describe.skip;

run('durable runner (Postgres)', () => {
  const sql = postgres(LAB as string, { max: 4, onnotice: () => {} });
  const admin = postgres(ADMIN as string, { max: 1, onnotice: () => {} });
  const quiet = () => {};

  beforeEach(async () => {
    await admin`TRUNCATE rehearsal.release_decisions, rehearsal.events, rehearsal.episodes, rehearsal.runs, rehearsal.training_runs`;
  });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });

  const events = (episodeId: string) =>
    sql<{ seq: number; kind: string; data: Record<string, unknown>; prev_hash: string; hash: string; attempt: number }[]>`
      SELECT seq, kind, data, prev_hash, hash, attempt FROM rehearsal.events WHERE episode_id = ${episodeId} ORDER BY seq`;

  it('runs a queued run to completion and writes a summary', async () => {
    const runId = await enqueueRun(sql, { agent: 'careful', split: 'golden', scenarios: goldenSet(), budgetPaisa: 0 });
    expect(await workLoop(sql, 'w1', { log: quiet })).toBe(12);
    const [r] = await sql<{ status: string; summary: { pass_rate: number; n: number } }[]>`SELECT status, summary FROM rehearsal.runs WHERE id = ${runId}`;
    expect(r).toMatchObject({ status: 'completed', summary: { pass_rate: 1, n: 12 } });
  });

  it('crash mid-episode → another worker resumes from the checkpoint, exactly-once saves, intact chain', async () => {
    await enqueueRun(sql, { agent: 'careful', split: 'golden', scenarios: [getScenario('multi_turn/000')], budgetPaisa: 0 });
    const c1 = await claim(sql, 'doomed');
    await expect(runClaimed(sql, c1!, { crashAfterSteps: 4 })).rejects.toBeInstanceOf(SimulatedCrash);
    // The process "died": its lease simply runs out.
    await admin`UPDATE rehearsal.episodes SET lease_until = now() - interval '1 second'`;
    const c2 = await claim(sql, 'rescuer');
    expect(c2?.attempt).toBe(2);
    expect(c2?.checkpoint?.env.state.step).toBe(4); // resumes exactly where it died
    const r = await runClaimed(sql, c2!);
    expect(r.passed).toBe(true);
    const evs = await events(c2!.id);
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i));
    expect(verifyChain(evs as never).ok).toBe(true);
    const confirms = evs.filter((e) => e.kind === 'ledger_write' && e.data['op'] === 'confirm');
    expect(new Set(confirms.map((e) => e.data['entry_id'])).size).toBe(confirms.length);
    expect(new Set(evs.map((e) => e.attempt))).toEqual(new Set([1, 2])); // both lives appear in one chain
  });

  it('PROBE zombie worker: after its lease is taken over, its next write is fenced off (LeaseLost)', async () => {
    await enqueueRun(sql, { agent: 'careful', split: 'golden', scenarios: [getScenario('bill_extraction/000')], budgetPaisa: 0 });
    const zombie = await claim(sql, 'zombie');
    await admin`UPDATE rehearsal.episodes SET lease_until = now() - interval '1 second'`;
    const owner = await claim(sql, 'owner');
    expect(owner?.lease_token).toBe((zombie?.lease_token ?? 0) + 1);
    await expect(runClaimed(sql, zombie!)).rejects.toBeInstanceOf(LeaseLost);
    const r = await runClaimed(sql, owner!);
    expect(r.passed).toBe(true);
  });

  it('PROBE corrupted checkpoint is quarantined, never resumed', async () => {
    await enqueueRun(sql, { agent: 'careful', split: 'golden', scenarios: [getScenario('vat_edge/000')], budgetPaisa: 0 });
    const c = await claim(sql, 'w');
    await runClaimed(sql, c!, { crashAfterSteps: 2 }).catch(() => undefined);
    // Someone edits the stored checkpoint (disk corruption, bad manual fix, tampering).
    await admin`UPDATE rehearsal.episodes SET lease_until = now() - interval '1 second',
                checkpoint = jsonb_set(checkpoint, '{steps}', '[]'::jsonb)`;
    const again = await claim(sql, 'w2');
    expect(digest(again!.checkpoint)).not.toBe(again!.checkpoint_digest);
    await expect(runClaimed(sql, again!)).rejects.toThrow(/quarantined/);
    const [row] = await sql<{ status: string }[]>`SELECT status FROM rehearsal.episodes WHERE id = ${again!.id}`;
    expect(row?.status).toBe('quarantined');
  });

  it('PROBE event log is append-only for the lab role (UPDATE/DELETE refused by Postgres)', async () => {
    await enqueueRun(sql, { agent: 'careful', split: 'golden', scenarios: [getScenario('draft_only/000')], budgetPaisa: 0 });
    await workLoop(sql, 'w', { log: quiet });
    await expect(sql`UPDATE rehearsal.events SET data = '{}'::jsonb`).rejects.toThrow(/permission denied/);
    await expect(sql`DELETE FROM rehearsal.events`).rejects.toThrow(/permission denied/);
  });

  it('PROBE isolation: the lab role cannot read or write ANY customer table', async () => {
    for (const table of ['sales', 'expenses', 'tenants', 'audit_log', 'users', 'app_settings']) {
      await expect(sql.unsafe(`SELECT 1 FROM public.${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
    await expect(sql`INSERT INTO public.sales (tenant_id) VALUES (gen_random_uuid())`).rejects.toThrow(/permission denied/);
  });

  it('PROBE a failing candidate can never be recorded as approved (DB CHECK, not just UI)', async () => {
    const a = await enqueueRun(sql, { agent: 'careful', split: 'golden', scenarios: [getScenario('draft_only/000')], budgetPaisa: 0 });
    await expect(
      admin`INSERT INTO rehearsal.release_decisions (candidate, baseline_run_id, candidate_run_id, gate, decision, reason, comparison, decided_by)
            VALUES ('x', ${a}, ${a}, 'FAIL', 'approved', 'ship it anyway', '{}'::jsonb, 'admin')`,
    ).rejects.toThrow(/check constraint/);
  });
});
