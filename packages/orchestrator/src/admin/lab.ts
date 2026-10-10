/**
 * Admin → Agent Lab. Read-mostly views over the Rehearsal Lab (`rehearsal` schema):
 *
 *   /admin/lab                      runs, training runs, release decisions
 *   /admin/lab/runs/:id             one evaluation run: by family, failure classes, every episode
 *   /admin/lab/episodes/:id         one episode, step by step: owner ↔ agent ↔ tools ↔ ledger ↔ gate,
 *                                   the judge's verdict, hash-chain check, LangSmith trace link
 *   /admin/lab/training/:id         a GRPO training run: learning curves + held-out result
 *   /admin/lab/release              pick baseline vs candidate → release gate → human Approve / Reject
 *
 * Same security as every admin page (session, CSRF, same-origin, audit). The only
 * write is a release decision, and the DB itself refuses "approved" for a non-PASS
 * gate (CHECK constraint in migration 0024), whatever this form sends.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '@hisab/db';
import { releaseGate, verifyEventChain, wilson, type GateRun } from '@hisab/shared';
import { csrfField, esc, fmtDate, layout, pill, type Tone } from './html.js';

export interface LabRouteHelpers {
  db: Db;
  html(reply: FastifyReply, body: string, status?: number): FastifyReply;
  back(reply: FastifyReply, path: string, tone: Tone, text: string): FastifyReply;
  flashOf(req: FastifyRequest): { tone: Tone; text: string } | undefined;
  csrf(req: FastifyRequest): string;
  event(actor: string, action: string, detail: Record<string, unknown>, ip?: string): PromiseLike<unknown>;
  clientIp(req: FastifyRequest): string;
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');
const rs = (paisa: unknown) => `Rs ${(Number(paisa ?? 0) / 100).toFixed(2)}`;
const passPill = (p: unknown) => (p === true ? pill('PASS', 'ok') : p === false ? pill('FAIL', 'bad') : pill('—', 'muted'));

async function rows(db: Db, query: ReturnType<typeof sql>): Promise<Row[]> {
  return [...((await db.execute(query)) as unknown as Row[])];
}

export function registerLabRoutes(app: FastifyInstance, h: LabRouteHelpers): void {
  const page = (req: FastifyRequest, reply: FastifyReply, title: string, body: string) =>
    h.html(reply, layout({ title, path: '/admin/lab', body: `${LAB_NAV}${body}`, csrf: h.csrf(req), flash: h.flashOf(req) }));

  // ------------------------------------------------------------------ overview
  app.get('/admin/lab', async (req, reply) => {
    const runs = await rows(h.db, sql`
      SELECT r.id, r.experiment, r.agent_version, r.split, r.status, r.created_at, r.summary,
             (SELECT count(*) FROM rehearsal.episodes e WHERE e.run_id = r.id)::int AS episodes,
             (SELECT count(*) FROM rehearsal.episodes e WHERE e.run_id = r.id AND e.status = 'completed')::int AS done,
             (SELECT count(*) FROM rehearsal.episodes e WHERE e.run_id = r.id AND e.status = 'quarantined')::int AS quarantined
        FROM rehearsal.runs r ORDER BY r.created_at DESC LIMIT 50`);
    const training = await rows(h.db, sql`
      SELECT id, name, algorithm, reward_version, created_at, evaluation->'dev_after' AS dev_after, evaluation->'dev_before' AS dev_before, evaluation->'test' AS test
        FROM rehearsal.training_runs ORDER BY created_at DESC LIMIT 30`);
    const decisions = await rows(h.db, sql`
      SELECT candidate, gate, decision, reason, decided_by, decided_at FROM rehearsal.release_decisions ORDER BY decided_at DESC LIMIT 20`);
    const totals = await rows(h.db, sql`
      SELECT count(*)::int AS episodes,
             count(*) FILTER (WHERE passed)::int AS passed,
             coalesce(sum(cardinality(hard)), 0)::int AS hard,
             coalesce(sum(cost_paisa), 0)::bigint AS cost,
             count(*) FILTER (WHERE status = 'running' AND lease_until < now())::int AS stale_leases,
             count(*) FILTER (WHERE status = 'quarantined')::int AS quarantined
        FROM rehearsal.episodes`);
    const t = totals[0] ?? {};

    const runTable = runs.length
      ? `<table><tr><th>When</th><th>Agent</th><th>Split</th><th>Progress</th><th>Pass rate (95% CI)</th><th>Hard</th><th>Cost</th></tr>${runs
          .map((r) => {
            const s = (r['summary'] ?? {}) as { pass_rate?: number; pass_ci95?: { low: number; high: number }; hard_violations?: number; cost_paisa?: number };
            return `<tr><td>${fmtDate(r['created_at'] as string)}</td><td><a href="/admin/lab/runs/${esc(r['id'])}">${esc(r['agent_version'])}</a></td>
              <td>${esc(r['split'])}</td><td>${esc(r['done'])}/${esc(r['episodes'])}${Number(r['quarantined']) ? ` ${pill(`${String(r['quarantined'])} quarantined`, 'bad')}` : ''}</td>
              <td>${s.pass_rate !== undefined ? `${pct(s.pass_rate)} <small>(${pct(s.pass_ci95?.low)}–${pct(s.pass_ci95?.high)})</small>` : pill(String(r['status']), 'muted')}</td>
              <td>${s.hard_violations ? pill(String(s.hard_violations), 'bad') : '0'}</td><td>${rs(s.cost_paisa)}</td></tr>`;
          })
          .join('')}</table>`
      : `<p class="mut">No runs yet. Run <code>pnpm lab eval --agent careful --split dev --save</code>.</p>`;

    const trainTable = training.length
      ? `<table><tr><th>When</th><th>Run</th><th>Reward</th><th>Dev pass: before → after</th><th>Hard (dev)</th><th>Held-out test</th></tr>${training
          .map((r) => {
            const a = (r['dev_after'] ?? {}) as { pass_rate?: number; hard?: number };
            const b = (r['dev_before'] ?? {}) as { pass_rate?: number };
            const t = r['test'] as { pass_rate?: number; hard?: number; n?: number } | null;
            return `<tr><td>${fmtDate(r['created_at'] as string)}</td><td><a href="/admin/lab/training/${esc(r['id'])}">${esc(r['name'])}</a></td>
              <td>${esc(r['reward_version'])}</td><td>${pct(b.pass_rate)} → <b>${pct(a.pass_rate)}</b></td>
              <td>${a.hard ? pill(String(a.hard), 'bad') : pill('0', 'ok')}</td>
              <td>${t ? `<b>${pct(t.pass_rate)}</b> <small>n=${esc(t.n)}</small> ${t.hard ? pill(`${String(t.hard)} hard`, 'bad') : pill('0 hard', 'ok')}` : '—'}</td></tr>`;
          })
          .join('')}</table>`
      : `<p class="mut">No training runs imported yet. Load the committed results (free, includes the held-out test score):
         <code>bash agents-learning/scripts/vm-lab.sh import-training</code></p>`;

    const decisionTable = decisions.length
      ? `<table><tr><th>When</th><th>Candidate</th><th>Gate</th><th>Decision</th><th>Why</th><th>By</th></tr>${decisions
          .map(
            (d) => `<tr><td>${fmtDate(d['decided_at'] as string)}</td><td>${esc(d['candidate'])}</td><td>${gatePill(String(d['gate']))}</td>
              <td>${d['decision'] === 'approved' ? pill('approved', 'ok') : pill('rejected', 'bad')}</td><td>${esc(d['reason'])}</td><td>${esc(d['decided_by'])}</td></tr>`,
          )
          .join('')}</table>`
      : `<p class="mut">No release decisions yet.</p>`;

    const passRate = Number(t['episodes']) ? Number(t['passed']) / Number(t['episodes']) : null;
    page(
      req,
      reply,
      'Agent Lab',
      `<div class="grid">
        ${stat('Episodes judged', String(t['episodes'] ?? 0), passRate === null ? 'none yet' : `${pct(passRate)} passed`)}
        ${stat('Hard safety violations', String(t['hard'] ?? 0), 'unapproved saves · cross-tenant · duplicates', Number(t['hard']) ? 'bad' : 'ok')}
        ${stat('Model spend (lab)', rs(t['cost']), 'incl. prompt-cache discounts')}
        ${stat('Worker health', `${String(t['stale_leases'] ?? 0)} stale · ${String(t['quarantined'] ?? 0)} quarantined`, 'stale = a worker died; next worker resumes it', Number(t['quarantined']) ? 'warn' : 'ok')}
      </div>
      <div class="card"><h2>Evaluation runs</h2>${runTable}</div>
      <div class="card"><h2>Policy training (GRPO)</h2>${trainTable}</div>
      <div class="card"><h2>Release decisions (human gate)</h2>${decisionTable}<p><a class="btn ghost" href="/admin/lab/release">Review a candidate →</a></p></div>
      <p class="mut">Full LLM traces (prompts, tool calls, tokens) are in LangSmith, project <code>hisab-rehearsal</code>; this event log is the source of truth.</p>`,
    );
  });

  // ------------------------------------------------------------------ one run
  app.get<{ Params: { id: string } }>('/admin/lab/runs/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return h.html(reply, 'Not found', 404);
    const [run] = await rows(h.db, sql`SELECT * FROM rehearsal.runs WHERE id = ${req.params.id}`);
    if (!run) return h.html(reply, 'Not found', 404);
    const eps = await rows(h.db, sql`
      SELECT id, scenario_id, family, split, status, attempt, passed, reward, failure_class, hard, steps, cost_paisa, error, langsmith_run_id
        FROM rehearsal.episodes WHERE run_id = ${req.params.id} ORDER BY family, scenario_id`);
    const byFamily = new Map<string, { n: number; p: number }>();
    const classes = new Map<string, number>();
    for (const e of eps) {
      if (e['status'] !== 'completed') continue;
      const f = byFamily.get(String(e['family'])) ?? { n: 0, p: 0 };
      f.n += 1;
      if (e['passed']) f.p += 1;
      byFamily.set(String(e['family']), f);
      classes.set(String(e['failure_class']), (classes.get(String(e['failure_class'])) ?? 0) + 1);
    }
    const famRows = [...byFamily]
      .map(([f, v]) => {
        const ci = wilson(v.p, v.n);
        return `<tr><td>${esc(f)}</td><td>${v.p}/${v.n}</td><td>${bar(v.p / v.n)}</td><td><small>${pct(ci.low)}–${pct(ci.high)}</small></td></tr>`;
      })
      .join('');
    const epRows = eps
      .map(
        (e) => `<tr class="${e['passed'] ? '' : 'mut'}"><td><a href="/admin/lab/episodes/${esc(e['id'])}">${esc(e['scenario_id'])}</a></td><td>${esc(e['split'])}</td>
          <td>${e['status'] === 'completed' ? passPill(e['passed']) : pill(String(e['status']), e['status'] === 'quarantined' ? 'bad' : 'warn')}</td>
          <td>${esc(e['failure_class'] ?? '')}</td><td>${esc((e['hard'] as string[] | null)?.join(', ') ?? '')}</td><td>${esc(e['reward'] ?? '')}</td>
          <td>${esc(e['steps'] ?? '')}</td><td>${esc(e['attempt'])}</td><td>${rs(e['cost_paisa'])}</td></tr>`,
      )
      .join('');
    page(
      req,
      reply,
      `Run · ${String(run['agent_version'])}`,
      `<div class="card kv"><b>Experiment</b><span>${esc(run['experiment'])}</span><b>Split</b><span>${esc(run['split'])}</span>
        <b>Dataset</b><span>${esc(run['dataset_version'])} <code>${esc(String(run['dataset_hash']).slice(0, 12))}</code></span>
        <b>Env / judge</b><span>${esc(run['env_version'])} / ${esc(run['judge_version'])}</span><b>Status</b><span>${esc(run['status'])}</span></div>
      <div class="grid"><div class="card"><h2>By family</h2><table><tr><th>Family</th><th>Pass</th><th></th><th>95% CI</th></tr>${famRows}</table></div>
      <div class="card"><h2>Failure taxonomy</h2><table>${[...classes].map(([c, n]) => `<tr><td>${c === 'PASS' ? pill(c, 'ok') : pill(c, 'bad')}</td><td>${n}</td></tr>`).join('')}</table></div></div>
      <div class="card"><h2>Episodes</h2><table><tr><th>Scenario</th><th>Split</th><th>Result</th><th>Class</th><th>Hard</th><th>Reward</th><th>Steps</th><th>Attempt</th><th>Cost</th></tr>${epRows}</table></div>`,
    );
  });

  // ------------------------------------------------------------------ one episode (the trajectory)
  app.get<{ Params: { id: string } }>('/admin/lab/episodes/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return h.html(reply, 'Not found', 404);
    const [ep] = await rows(h.db, sql`
      SELECT e.*, r.agent_version FROM rehearsal.episodes e JOIN rehearsal.runs r ON r.id = e.run_id WHERE e.id = ${req.params.id}`);
    if (!ep) return h.html(reply, 'Not found', 404);
    const events = await rows(h.db, sql`
      SELECT seq, kind, data, attempt, prev_hash, hash, created_at FROM rehearsal.events WHERE episode_id = ${req.params.id} ORDER BY seq`);
    const chain = verifyEventChain(events as never);
    const v = (ep['verdict'] ?? null) as Verdictish | null;
    const timeline = events.map((e) => eventRow(e)).join('');
    const checks = v
      ? v.trajectory.checks.map((c) => `<tr><td>${c.passed ? pill('✓', 'ok') : pill('✗', c.required ? 'bad' : 'warn')}</td><td>${esc(c.name)}${c.required ? ' <small>(required)</small>' : ''}</td><td>${esc(c.detail)}</td></tr>`).join('')
      : '';
    page(
      req,
      reply,
      `Episode · ${String(ep['scenario_id'])}`,
      `<div class="grid">
        <div class="card kv"><b>Agent</b><span>${esc(ep['agent_version'])}</span><b>Result</b><span>${passPill(ep['passed'])} ${esc(ep['failure_class'] ?? '')}</span>
          <b>Reward</b><span>${esc(ep['reward'] ?? '—')}</span><b>Steps</b><span>${esc(ep['steps'] ?? '—')}</span><b>Attempts</b><span>${esc(ep['attempt'])}${Number(ep['attempt']) > 1 ? ` ${pill('resumed after crash', 'warn')}` : ''}</span>
          <b>Tokens</b><span>${esc(ep['input_tokens'])} in / ${esc(ep['output_tokens'])} out · ${rs(ep['cost_paisa'])}</span>
          <b>Event chain</b><span>${chain.ok ? pill(`intact (${events.length} events)`, 'ok') : pill(`BROKEN at seq ${chain.broken_at}`, 'bad')}</span>
          ${ep['langsmith_run_id'] ? `<b>LangSmith</b><span><code>${esc(ep['langsmith_run_id'])}</code></span>` : ''}
          <b>Replay</b><span><code>pnpm lab run --agent &lt;agent&gt; --scenario ${esc(ep['scenario_id'])}</code></span></div>
        <div class="card"><h2>Judge verdict</h2>${
          v
            ? `<p>${v.hard.length ? v.hard.map((x) => pill(x.code, 'bad') + ` <small>${esc(x.detail)}</small>`).join('<br>') : pill('no hard violation', 'ok')}</p>
               <p>Outcome ${bar(v.outcome.score)} · Trajectory ${bar(v.trajectory.score)}</p>
               <small>expected ${esc(JSON.stringify(v.outcome.expected))}<br>saved ${esc(JSON.stringify(v.outcome.actual))}</small>
               <table>${checks}</table>`
            : '<p class="mut">Not judged yet.</p>'
        }</div></div>
      <div class="card"><h2>Trajectory (append-only event log)</h2><table><tr><th>#</th><th>Event</th><th>Detail</th></tr>${timeline}</table></div>`,
    );
  });

  // ------------------------------------------------------------------ training run (learning curves)
  app.get<{ Params: { id: string } }>('/admin/lab/training/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return h.html(reply, 'Not found', 404);
    const [t] = await rows(h.db, sql`SELECT * FROM rehearsal.training_runs WHERE id = ${req.params.id}`);
    if (!t) return h.html(reply, 'Not found', 404);
    const curve = (t['curve'] ?? []) as Array<Record<string, number>>;
    const ev = (t['evaluation'] ?? {}) as Record<string, unknown>;
    page(
      req,
      reply,
      `Training · ${String(t['name'])}`,
      `<div class="card kv"><b>Algorithm</b><span>${esc(t['algorithm'])}</span><b>Reward</b><span>${esc(t['reward_version'])}</span>
        <b>Config</b><span><code>${esc(JSON.stringify(t['config']))}</code></span></div>
      <div class="grid">
        <div class="card"><h2>Judge reward</h2>${lineChart(curve.map((p) => p['mean_judge_reward'] ?? 0), -1, 1)}</div>
        <div class="card"><h2>Pass rate</h2>${lineChart(curve.map((p) => p['pass_rate'] ?? 0), 0, 1)}</div>
        <div class="card"><h2>Hard-violation rate</h2>${lineChart(curve.map((p) => p['hard_violation_rate'] ?? 0), 0, 1, 'var(--bad)')}</div>
      </div>
      <div class="card"><h2>Dev split (greedy policy)</h2><code>${esc(JSON.stringify({ before: ev['dev_before'], after: ev['dev_after'] }))}</code>
        ${ev['test'] ? `<h2>Held-out TEST (measured once, after training)</h2><code>${esc(JSON.stringify(ev['test']))}</code>` : ''}
        <p class="mut">Held-out TEST is never used in training: <code>pnpm lab eval --agent policy:${esc(String(ev['weights_file'] ?? '').replace(/^agents-learning\//, ''))} --split test</code></p></div>`,
    );
  });

  // ------------------------------------------------------------------ release gate (human in the loop)
  app.get('/admin/lab/release', async (req, reply) => {
    const q = req.query as { baseline?: string; candidate?: string };
    const runs = await rows(h.db, sql`
      SELECT id, agent_version, split, created_at FROM rehearsal.runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 100`);
    const opts = (sel?: string) => runs.map((r) => `<option value="${esc(r['id'])}" ${sel === r['id'] ? 'selected' : ''}>${esc(r['agent_version'])} · ${esc(r['split'])} · ${fmtDate(r['created_at'] as string)}</option>`).join('');
    let result = '';
    if (q.baseline && q.candidate && UUID.test(q.baseline) && UUID.test(q.candidate)) {
      const g = await gateFor(h.db, q.baseline, q.candidate);
      result = `<div class="card"><h2>Gate: ${gatePill(g.gate)}</h2>
        <p>${g.reasons.map(esc).join('<br>')}</p>
        <div class="kv"><b>Paired scenarios</b><span>${g.n_paired}</span><b>Pass rate</b><span>${pct(g.baseline_pass_rate)} → <b>${pct(g.candidate_pass_rate)}</b> (Δ ${pct(g.delta)})</span>
        <b>McNemar (exact)</b><span>baseline-only ${g.mcnemar.b}, candidate-only ${g.mcnemar.c}, p = ${g.mcnemar.p_value}</span>
        <b>Hard violations</b><span>${g.hard_violations.baseline} → ${g.hard_violations.candidate}</span></div>
        <form method="post" action="/admin/lab/release">${csrfField(h.csrf(req))}
          <input type="hidden" name="baseline" value="${esc(q.baseline)}"><input type="hidden" name="candidate" value="${esc(q.candidate)}">
          <label for="reason">Your reasoning (recorded, required)</label><textarea id="reason" name="reason" rows="2" required minlength="3" maxlength="1000"></textarea>
          <p class="row"><button name="decision" value="approved" ${g.gate === 'PASS' ? '' : 'disabled title="Only a PASS gate can be approved"'}>Approve release</button>
          <button class="danger" name="decision" value="rejected">Reject</button></p></form>
        <p class="mut">Approving records the decision. Shipping it is a normal reviewed PR + CD deploy — nothing in the lab changes production by itself.</p></div>`;
    }
    page(
      req,
      reply,
      'Release review',
      `<div class="card"><form method="get" action="/admin/lab/release">
        <label>Baseline run (what production does today)</label><select name="baseline">${opts(q.baseline)}</select>
        <label>Candidate run (the proposed change)</label><select name="candidate">${opts(q.candidate)}</select>
        <p><button>Compare</button></p></form></div>${result}`,
    );
  });

  app.post('/admin/lab/release', async (req, reply) => {
    const f = req.body as Record<string, string | undefined>;
    const baseline = f['baseline'] ?? '';
    const candidate = f['candidate'] ?? '';
    const decision = f['decision'];
    const reason = (f['reason'] ?? '').trim();
    if (!UUID.test(baseline) || !UUID.test(candidate) || (decision !== 'approved' && decision !== 'rejected') || reason.length < 3) {
      return h.back(reply, '/admin/lab/release', 'bad', 'Pick two runs, a decision and a reason.');
    }
    // Recompute server-side: never trust a gate value from the browser.
    const g = await gateFor(h.db, baseline, candidate);
    if (decision === 'approved' && g.gate !== 'PASS') {
      return h.back(reply, '/admin/lab/release', 'bad', `Cannot approve: gate is ${g.gate}.`);
    }
    await h.db.execute(sql`
      INSERT INTO rehearsal.release_decisions (candidate, baseline_run_id, candidate_run_id, gate, decision, reason, comparison, decided_by)
      VALUES (${g.candidate}, ${baseline}, ${candidate}, ${g.gate}, ${decision}, ${reason}, ${JSON.stringify(g)}::jsonb, 'admin')`);
    await h.event('admin', `lab.release.${decision}`, { candidate: g.candidate, baseline: g.baseline, gate: g.gate }, h.clientIp(req));
    return h.back(reply, '/admin/lab', decision === 'approved' ? 'ok' : 'warn', `Release ${decision}: ${g.candidate}`);
  });
}

// ---------------------------------------------------------------------- helpers

const LAB_NAV = `<p class="row"><a class="btn ghost" href="/admin/lab">Lab overview</a><a class="btn ghost" href="/admin/lab/release">Release review</a></p>`;

async function gateFor(db: Db, baselineId: string, candidateId: string) {
  const load = async (id: string): Promise<GateRun> => {
    const [r] = await rows(db, sql`SELECT agent_version, dataset_hash, status FROM rehearsal.runs WHERE id = ${id}`);
    const cases = await rows(db, sql`SELECT scenario_id, passed, hard, status FROM rehearsal.episodes WHERE run_id = ${id}`);
    return {
      label: String(r?.['agent_version'] ?? id),
      dataset_hash: String(r?.['dataset_hash'] ?? ''),
      complete: r?.['status'] === 'completed' && cases.every((c) => c['status'] === 'completed'),
      cases: cases.map((c) => ({ scenario_id: String(c['scenario_id']), passed: c['passed'] === true, hard: (c['hard'] as string[] | null) ?? [] })),
    };
  };
  return releaseGate(await load(baselineId), await load(candidateId));
}

const gatePill = (g: string) => pill(g, g === 'PASS' ? 'ok' : g === 'FAIL' ? 'bad' : 'warn');

function stat(label: string, value: string, sub: string, tone: Tone = 'muted'): string {
  return `<div class="card"><small>${esc(label)}</small><div style="font-size:22px;font-weight:700" class="${tone === 'muted' ? '' : tone}">${esc(value)}</div><small>${esc(sub)}</small></div>`;
}

function bar(x: number): string {
  const w = Math.round(Math.max(0, Math.min(1, x)) * 100);
  return `<span style="display:inline-block;width:80px;height:8px;border-radius:4px;background:var(--line);vertical-align:middle"><span style="display:block;width:${w}%;height:8px;border-radius:4px;background:var(--ok)"></span></span> ${w}%`;
}

/** Tiny inline SVG line chart (CSP-safe: no script, no external asset). */
function lineChart(ys: number[], lo: number, hi: number, color = 'var(--brand)'): string {
  if (ys.length < 2) return '<p class="mut">not enough points</p>';
  const W = 320;
  const H = 120;
  const x = (i: number) => (i / (ys.length - 1)) * (W - 10) + 5;
  const y = (v: number) => H - 5 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 10);
  const d = ys.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zero = lo < 0 ? `<line x1="5" x2="${W - 5}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)" stroke-dasharray="3 3"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="learning curve">${zero}<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/></svg>
    <small>first ${ys[0]?.toFixed(3)} → last ${ys[ys.length - 1]?.toFixed(3)} · ${ys.length} iterations</small>`;
}

interface Verdictish {
  hard: Array<{ code: string; detail: string }>;
  outcome: { score: number; expected: unknown; actual: unknown };
  trajectory: { score: number; checks: Array<{ name: string; passed: boolean; required: boolean; detail: string }> };
}

const KIND_TONE: Record<string, Tone> = {
  owner_message: 'ok',
  agent_message: 'ok',
  ledger_write: 'warn',
  cross_tenant_attempt: 'bad',
  invalid_action: 'bad',
  fault_injected: 'bad',
};

function eventRow(e: Row): string {
  const kind = String(e['kind']);
  const d = (e['data'] ?? {}) as Row;
  let detail: string;
  switch (kind) {
    case 'owner_message':
    case 'agent_message':
      detail = `<div style="white-space:pre-wrap">${esc(d['text'])}</div>`;
      break;
    case 'tool_call':
      detail = `<b>${esc(d['name'])}</b> <code>${esc(JSON.stringify(d['args']))}</code>`;
      break;
    case 'tool_result':
      detail = `${d['ok'] ? pill('ok', 'ok') : pill('error', 'bad')} <code>${esc(JSON.stringify(d['data']).slice(0, 600))}</code>`;
      break;
    case 'ledger_write':
      detail = `<b>${esc(d['op'])}</b> ${esc(d['entry_type'])} Rs ${(Number(d['total_paisa']) / 100).toFixed(2)}${
        d['op'] === 'confirm' ? ` ${d['owner_approved'] ? pill('owner approved', 'ok') : pill('NOT approved by owner', 'bad')}` : ''
      }`;
      break;
    case 'gate_decision':
      detail = d['action'] === 'deliver' ? pill('Audit Gate: deliver', 'ok') : `${pill('Audit Gate: HOLD', 'bad')} ${esc((d['reasons'] as string[]).join('; '))}`;
      break;
    default:
      detail = `<code>${esc(JSON.stringify(d).slice(0, 400))}</code>`;
  }
  const attempt = Number(e['attempt']) > 1 ? ` ${pill(`attempt ${String(e['attempt'])}`, 'warn')}` : '';
  return `<tr><td>${esc(e['seq'])}</td><td>${pill(kind, KIND_TONE[kind] ?? 'muted')}${attempt}</td><td>${detail}</td></tr>`;
}
