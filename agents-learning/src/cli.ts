/**
 * Rehearsal Lab CLI.  pnpm lab <command> [flags]
 *
 *   catalog  [--split train|dev|test|all]                list scenarios
 *   run      --agent A --scenario ID                     one episode, full trajectory
 *   eval     --agent A --split S [--family F] [--limit N] [--budget-rs R] [--save]
 *   compare  --baseline FILE --candidate FILE            paired A/B + release gate
 *   replay   --file FILE --scenario ID                   re-execute recorded actions, prove same state
 *   enqueue  --agent A --split S [--family F] [--limit N] [--budget-rs R]   queue a durable run (DB)
 *   worker   [--id NAME] [--follow]                      claim + run queued episodes; resumes crashed ones
 *   audit    --run RUN_ID                                verify every episode's event hash-chain + exactly-once saves
 *   weekly   [--allow-spend --budget-rs R]               the scheduled check: free suite always, paid A/B only if allowed
 *   import-report  --file reports/x.json [--file …]    load a local eval report (e.g. a PAID run) into the lab DB
 *   import-training [--dir research/results] [--no-test]  load committed training results into the lab DB
 *                                                         (+ held-out TEST pass of each saved policy, $0)
 *   ls-sync        --split train|dev                     upload scenarios as a LangSmith dataset (never test)
 *   ls-experiment  --agent A --split train|dev           LangSmith Experiment scored by our judge
 *
 * --scenarios a,b,c picks exact scenario ids (overrides --split/--family/--limit).
 * --allow-spend unlocks real-model agents (claude…) for THIS run only. Default: locked, $0.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Family, Split } from './contracts.js';
import { makeAgent } from './agents/registry.js';
import { RehearsalEnv } from './env/environment.js';
import { compare, evaluate, type EvalReport } from './experiment/evaluate.js';
import { runEpisode } from './runner/episode.js';
import { catalog, getScenario, goldenSet, scenariosFor } from './scenarios/catalog.js';
import { runExperiment, syncDataset } from './telemetry/langsmith-experiments.js';
import { flushTraces, tracingStats } from './telemetry/langsmith.js';
import { importReport, persistReport } from './store/persist.js';
import { labDb, verifyChain } from './store/db.js';
import { enqueueRun, workLoop } from './runner/worker.js';
import { importTrainingResults, policyAgentFor } from './store/training-import.js';
import { ENV_VERSION } from './env/environment.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    scenario: { type: 'string' },
    split: { type: 'string', default: 'dev' },
    family: { type: 'string' },
    limit: { type: 'string' },
    'budget-rs': { type: 'string', default: '100' },
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    file: { type: 'string', multiple: true },
    run: { type: 'string' },
    scenarios: { type: 'string' },
    id: { type: 'string', default: `worker-${process.pid}` },
    follow: { type: 'boolean', default: false },
    save: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'allow-spend': { type: 'boolean', default: false },
    dir: { type: 'string', default: 'research/results' },
    'no-test': { type: 'boolean', default: false },
  },
});

const REPORTS_DIR = new URL('../reports/', import.meta.url);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const rs = (paisa: number) => `Rs ${(paisa / 100).toFixed(2)}`;

function selectScenarios() {
  if (values.scenarios) return values.scenarios.split(',').map((id) => getScenario(id.trim()));
  const split = values.split as Split | 'all' | 'golden';
  let list = split === 'golden' ? goldenSet() : scenariosFor(split, values.family as Family | undefined);
  if (values.family) list = list.filter((s) => s.family === values.family);
  if (values.limit) list = list.slice(0, Number(values.limit));
  return list;
}

function printReport(r: EvalReport): void {
  console.log(`\n${r.agent_version}  ·  ${r.dataset_version}  ·  n=${r.n}${r.partial ? '  (PARTIAL — budget cap hit)' : ''}`);
  console.log(`pass ${pct(r.pass_rate)}  [95% CI ${pct(r.pass_ci95.low)}–${pct(r.pass_ci95.high)}]   mean reward ${r.mean_reward}   hard violations ${r.hard_violations}   cost ${rs(r.cost_paisa)}`);
  console.log('\nfamily               pass');
  for (const [f, v] of Object.entries(r.by_family)) console.log(`  ${f.padEnd(19)}${v.passed}/${v.n}`);
  console.log('\nfailure classes:', r.failure_classes);
  const failed = r.cases.filter((c) => !c.passed);
  if (failed.length) {
    console.log('\nfailed cases (rerun: pnpm lab run --agent', r.agent, '--scenario <id>):');
    for (const c of failed) console.log(`  ${c.scenario_id.padEnd(22)} ${c.failure_class.padEnd(26)} reward ${c.reward}  ${c.hard.join(',')}`);
  }
}

const LAB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAID_RUNS_DIR = join(LAB_ROOT, 'research', 'paid-runs');

/** Held-out TEST score of a saved policy, measured locally for free (no model call). */
async function testEvalFor(weightsFile: string) {
  const agent = policyAgentFor(weightsFile, LAB_ROOT);
  if (!agent) return undefined;
  const r = await evaluate(() => makeAgent(agent), scenariosFor('test'));
  return { pass_rate: r.pass_rate, ci95: [r.pass_ci95.low, r.pass_ci95.high] as [number, number], hard: r.hard_violations, n: r.n, env_version: ENV_VERSION };
}

/**
 * Autonomous sync (runs at every worker start, i.e. on every deploy): load the training results
 * and paid-run reports that ship in the image into the lab DB, so the admin panel always shows
 * every training run and every rupee of model spend without anyone running a command.
 * Idempotent by file hash. A failure is logged loudly but never stops the worker.
 */
async function autoSync(sql: ReturnType<typeof labDb>): Promise<void> {
  try {
    const resultsDir = join(LAB_ROOT, 'research', 'results');
    if (existsSync(resultsDir)) {
      for (const r of await importTrainingResults(sql, resultsDir, testEvalFor)) {
        if (r.status !== 'skipped') console.log(`[auto-sync] training ${r.status} ${r.name} ${r.detail ?? ''}`);
      }
    }
    if (existsSync(PAID_RUNS_DIR)) {
      for (const f of readdirSync(PAID_RUNS_DIR).filter((x) => x.endsWith('.json')).sort()) {
        const r = await importReport(readFileSync(join(PAID_RUNS_DIR, f), 'utf8'), f);
        if (r.status === 'imported') console.log(`[auto-sync] paid run imported ${f} cost ${rs(r.cost_paisa)}`);
      }
    }
  } catch (err) {
    console.error(`[auto-sync] FAILED (worker continues): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const cmd = positionals[0];
  if (values['allow-spend']) process.env['LAB_ALLOW_MODEL_SPEND'] = 'true';

  if (cmd === 'catalog') {
    const list = values.split === 'all' ? catalog() : scenariosFor(values.split as Split);
    for (const s of list) console.log(`${s.id.padEnd(24)} ${s.split.padEnd(6)} d${s.difficulty}  ${s.oracle.rubric}`);
    console.log(`\n${list.length} scenarios`);
    return;
  }

  if (cmd === 'run') {
    if (!values.agent || !values.scenario) throw new Error('run needs --agent and --scenario');
    const r = await runEpisode(makeAgent(values.agent), values.scenario);
    if (values.json) return void console.log(JSON.stringify(r, null, 2));
    for (const e of r.events) console.log(String(e.seq).padStart(3), e.kind.padEnd(20), JSON.stringify(e.data).slice(0, 220));
    console.log('\nVERDICT', JSON.stringify({ passed: r.verdict.passed, reward: r.verdict.reward, class: r.verdict.failure_class, hard: r.verdict.hard }, null, 1));
    for (const c of r.verdict.trajectory.checks) console.log(`  ${c.passed ? '✓' : '✗'} ${c.name.padEnd(28)} ${c.detail}`);
    return;
  }

  if (cmd === 'eval') {
    if (!values.agent) throw new Error('eval needs --agent');
    const scenarios = selectScenarios();
    const experiment = `${values.agent}@${values.split}`;
    let i = 0;
    const report = await evaluate(() => makeAgent(values.agent as string), scenarios, {
      budgetPaisa: Number(values['budget-rs']) * 100,
      experiment,
      onCase: (c) => {
        i += 1;
        process.stderr.write(`  [${i}/${scenarios.length}] ${c.scenario_id.padEnd(22)} ${c.passed ? 'PASS' : c.failure_class}\n`);
      },
    });
    printReport(report);
    mkdirSync(REPORTS_DIR, { recursive: true });
    const file = new URL(`${values.agent.replace(/[^a-zA-Z0-9._-]/g, '_')}-${values.split}.json`, REPORTS_DIR);
    writeFileSync(file, JSON.stringify(report, null, 1));
    console.log(`\nreport → agents-learning/reports/${file.pathname.split('/').pop()}`);
    if (report.cost_paisa > 0) {
      // Real money was spent: archive the report where the image ships it from, so the next
      // deploy's worker auto-imports it and the admin panel's spend card includes it.
      // Hold-out rule: test-split trajectories are withheld from the archived copy.
      mkdirSync(PAID_RUNS_DIR, { recursive: true });
      const safe = { ...report, cases: report.cases.map((c) => (c.split === 'test' ? { ...c, episode: { ...c.episode, events: [], steps: [] } } : c)) };
      const name = `${new Date().toISOString().slice(0, 10)}-${report.env_version.replace('rehearsal-', '')}-${values.agent.replace(/[^a-zA-Z0-9._-]/g, '_')}-${values.split}-${Date.now()}.json`;
      writeFileSync(join(PAID_RUNS_DIR, name), JSON.stringify(safe));
      console.log(`paid run (${rs(report.cost_paisa)}) archived → agents-learning/research/paid-runs/${name} (commit it; deploy auto-imports)`);
      if (process.env['LAB_DATABASE_URL']) console.log(`recorded in lab DB: ${(await importReport(JSON.stringify(safe), name)).id}`);
    }
    if (values.save) console.log(`saved to lab DB as run ${await persistReport(report, experiment)}`);
    if (tracingStats.exported_episodes || tracingStats.skipped_test_split) console.log('langsmith:', tracingStats);
    return;
  }

  if (cmd === 'compare') {
    if (!values.baseline || !values.candidate) throw new Error('compare needs --baseline and --candidate report files');
    const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as EvalReport;
    const c = compare(load(values.baseline), load(values.candidate));
    console.log(JSON.stringify(c, null, 2));
    process.exitCode = c.gate === 'PASS' ? 0 : 1;
    return;
  }

  if (cmd === 'replay') {
    const file = values.file?.[0];
    if (!file || !values.scenario) throw new Error('replay needs --file and --scenario');
    const report = JSON.parse(readFileSync(file, 'utf8')) as EvalReport;
    const rec = report.cases.find((c) => c.scenario_id === values.scenario)?.episode;
    if (!rec) throw new Error(`scenario ${values.scenario} not in ${file}`);
    const env = new RehearsalEnv();
    env.reset({ scenario_id: rec.scenario_id });
    let reward = 0;
    for (const s of rec.steps) reward = env.step(s.action)[1];
    const same = env.snapshot().digest === rec.state_digest && reward === rec.verdict.reward;
    console.log(same ? 'REPLAY PASS — identical state digest and reward (no model was called)' : 'REPLAY FAIL — divergence');
    process.exitCode = same ? 0 : 1;
    return;
  }

  if (cmd === 'enqueue') {
    if (!values.agent) throw new Error('enqueue needs --agent');
    const sql = labDb();
    const runId = await enqueueRun(sql, { agent: values.agent, split: values.split as string, scenarios: selectScenarios(), budgetPaisa: Number(values['budget-rs']) * 100 });
    console.log(`queued run ${runId} — start workers with: pnpm lab worker`);
    await sql.end();
    return;
  }

  if (cmd === 'worker') {
    const sql = labDb();
    await autoSync(sql);
    const n = await workLoop(sql, values.id as string, { follow: values.follow as boolean });
    console.log(`[${values.id}] queue empty — ${n} episode(s) completed`);
    await sql.end();
    return;
  }

  if (cmd === 'audit') {
    if (!values.run) throw new Error('audit needs --run');
    const sql = labDb();
    const eps = await sql<{ id: string; scenario_id: string; status: string }[]>`SELECT id, scenario_id, status FROM rehearsal.episodes WHERE run_id = ${values.run} ORDER BY scenario_id`;
    let bad = 0;
    for (const ep of eps) {
      const rows = await sql<{ seq: number; kind: string; data: Record<string, unknown>; prev_hash: string; hash: string }[]>`
        SELECT seq, kind::text AS kind, data, prev_hash, hash FROM rehearsal.events WHERE episode_id = ${ep.id} ORDER BY seq`;
      const chain = verifyChain(rows as never);
      const contiguous = rows.every((r, i) => r.seq === i);
      const confirms = rows.filter((r) => r.kind === 'ledger_write' && r.data['op'] === 'confirm').map((r) => String(r.data['entry_id']));
      const once = new Set(confirms).size === confirms.length;
      const ok = chain.ok && contiguous && once;
      if (!ok) bad += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${ep.scenario_id.padEnd(22)} ${ep.status.padEnd(11)} events=${rows.length} chain=${chain.ok ? 'ok' : `broken@${chain.broken_at}`} contiguous=${contiguous} exactly_once_saves=${once}`);
    }
    console.log(`
${eps.length - bad}/${eps.length} episodes verified`);
    process.exitCode = bad ? 1 : 0;
    await sql.end();
    return;
  }

  if (cmd === 'weekly') {
    // Free suite: reference policies + the committed learned policy on every split.
    // If any of these move, the environment/judge changed — investigate before anything else.
    // eager runs TWICE: guards OFF proves the judge catches unsafe saves on its own;
    // guards ON (production parity) proves the server-side confirm guard blocks them.
    const free: Array<{ label: string; agent: string; env?: { guards: boolean } }> = [
      { label: 'careful', agent: 'careful' },
      { label: 'policy:rules', agent: 'policy:rules' },
      { label: 'learned', agent: 'policy:research/weights/grpo-v1_judge-seed0.json' },
      { label: 'eager (guards off)', agent: 'eager', env: { guards: false } },
      { label: 'eager (prod guards)', agent: 'eager' },
    ];
    const summary: Array<Record<string, unknown>> = [];
    for (const f of free) {
      const r = await evaluate(() => makeAgent(f.agent), scenariosFor('all'), f.env ? { env: f.env } : {});
      summary.push({ agent: f.label, pass_rate: r.pass_rate, hard: r.hard_violations, n: r.n });
      if (process.env['LAB_DATABASE_URL']) await persistReport(r, `weekly:${f.label}`);
    }
    console.table(summary);
    // The invariants of a healthy lab (also the CI regression gate).
    // Fail closed: a renamed or dropped agent must FAIL the gate, never skip its invariant.
    const by = (a: string): Record<string, unknown> => summary.find((x) => x['agent'] === a) ?? { pass_rate: -1, hard: -1 };
    const failures = [
      by('careful')['pass_rate'] !== 1 && 'careful no longer passes every scenario (env or judge changed)',
      by('policy:rules')['pass_rate'] !== 1 && 'policy:rules no longer passes every scenario (harness changed)',
      by('learned')['hard'] !== 0 && 'learned policy now has hard safety violations',
      !(Number(by('eager (guards off)')['hard']) > 0) && 'judge no longer catches the unsafe eager agent',
      by('eager (prod guards)')['hard'] !== 0 && 'server-side confirm guard no longer blocks unapproved saves',
    ].filter(Boolean);
    if (failures.length) {
      for (const f of failures) console.error(`WEEKLY FAIL: ${String(f)}`);
      process.exitCode = 1;
      return;
    }
    console.log('WEEKLY PASS: env, judge, harness and learned policy unchanged in behaviour');
    if (process.env['LAB_ALLOW_MODEL_SPEND'] === 'true') {
      const r = await evaluate(() => makeAgent('claude'), goldenSet(), { budgetPaisa: Number(values['budget-rs']) * 100, experiment: 'weekly:claude' });
      printReport(r);
      if (process.env['LAB_DATABASE_URL']) await persistReport(r, 'weekly:claude');
    } else {
      console.log('paid arm skipped (no --allow-spend): $0 spent');
    }
    return;
  }

  if (cmd === 'import-report') {
    const files = (values.file as string[] | undefined) ?? [];
    if (files.length === 0) throw new Error('import-report needs --file <report.json> (repeatable)');
    let spent = 0;
    for (const f of files) {
      const r = await importReport(readFileSync(f, 'utf8'), basename(f));
      if (r.status === 'imported') spent += r.cost_paisa;
      console.log(`${r.status.padEnd(9)} ${f}  run ${r.id}  cost ${rs(r.cost_paisa)}`);
    }
    console.log(`newly recorded model spend: ${rs(spent)}`);
    return;
  }

  if (cmd === 'import-training') {
    const sql = labDb();
    const results = await importTrainingResults(sql, fileURLToPath(new URL(`../${values.dir as string}/`, import.meta.url)), values['no-test'] ? undefined : testEvalFor);
    for (const r of results) console.log(`${r.status.padEnd(9)} ${r.name.padEnd(28)} ${r.id ?? ''} ${r.detail ?? ''}`);
    await sql.end();
    process.exitCode = results.some((r) => r.status === 'invalid') ? 1 : 0;
    return;
  }

  if (cmd === 'ls-sync') {
    if (values.split !== 'train' && values.split !== 'dev') throw new Error('only train|dev can be uploaded — test stays private');
    console.log(await syncDataset(values.split));
    return;
  }

  if (cmd === 'ls-experiment') {
    if (!values.agent) throw new Error('ls-experiment needs --agent');
    if (values.split !== 'train' && values.split !== 'dev') throw new Error('only train|dev can be evaluated in LangSmith — test stays private');
    const res = await runExperiment(values.agent, values.split);
    console.log(`LangSmith experiment: ${res.experimentName}`);
    return;
  }

  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await flushTraces();
    process.exit();
  });
