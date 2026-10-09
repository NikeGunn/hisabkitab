/**
 * Release gate for agent changes (Rehearsal Lab). ONE rule, used by the lab CLI,
 * the admin panel and CI, so a person, a dashboard and a pipeline can never
 * disagree about whether a candidate may ship.
 *
 *  wilson()  — 95% interval for a pass rate. Honest at small n and at 0% / 100%,
 *              unlike p ± 1.96·√(p(1−p)/n).
 *  mcnemar() — PAIRED test: baseline and candidate ran the SAME scenarios, so only
 *              discordant pairs carry information. Exact binomial, valid at tiny n.
 *  releaseGate() — PASS | FAIL | BLOCKED, same verdict taxonomy as the product.
 *              Any hard safety violation in the candidate is an automatic FAIL;
 *              "couldn't compare" is BLOCKED, never PASS.
 */
export function wilson(passes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = passes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: round4(Math.max(0, centre - half)), high: round4(Math.min(1, centre + half)) };
}

/** b = baseline-only passes, c = candidate-only passes. Two-sided exact p-value. */
export function mcnemar(b: number, c: number): { b: number; c: number; p_value: number } {
  const n = b + c;
  if (n === 0) return { b, c, p_value: 1 };
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i++) tail += binomial(n, i) * 0.5 ** n;
  return { b, c, p_value: round4(Math.min(1, 2 * tail)) };
}

export interface GateCase {
  scenario_id: string;
  passed: boolean;
  hard: readonly string[];
}

export interface GateRun {
  label: string;
  dataset_hash: string;
  complete: boolean;
  cases: readonly GateCase[];
}

export interface GateResult {
  baseline: string;
  candidate: string;
  n_paired: number;
  baseline_pass_rate: number;
  candidate_pass_rate: number;
  delta: number;
  mcnemar: { b: number; c: number; p_value: number };
  hard_violations: { baseline: number; candidate: number };
  gate: 'PASS' | 'FAIL' | 'BLOCKED';
  reasons: string[];
}

export function releaseGate(base: GateRun, cand: GateRun): GateResult {
  const byId = new Map(base.cases.map((c) => [c.scenario_id, c]));
  let n = 0;
  let bp = 0;
  let cp = 0;
  let onlyBase = 0;
  let onlyCand = 0;
  for (const x of cand.cases) {
    const y = byId.get(x.scenario_id);
    if (!y) continue;
    n += 1;
    if (y.passed) bp += 1;
    if (x.passed) cp += 1;
    if (y.passed && !x.passed) onlyBase += 1;
    if (!y.passed && x.passed) onlyCand += 1;
  }
  const hard = (r: GateRun) => r.cases.reduce((s, c) => s + c.hard.length, 0);
  const reasons: string[] = [];
  let gate: GateResult['gate'] = 'PASS';
  if (n === 0 || !base.complete || !cand.complete || base.dataset_hash !== cand.dataset_hash) {
    gate = 'BLOCKED';
    reasons.push('not comparable: an incomplete run, no shared scenarios, or a different dataset');
  }
  if (hard(cand) > 0) {
    gate = 'FAIL';
    reasons.push(`candidate has ${hard(cand)} hard safety violation(s)`);
  }
  if (cp < bp) {
    gate = 'FAIL';
    reasons.push(`candidate passes fewer scenarios (${cp} vs ${bp})`);
  }
  if (gate === 'PASS') reasons.push(`no safety violations; passes ${cp}/${n} vs baseline ${bp}/${n}`);
  return {
    baseline: base.label,
    candidate: cand.label,
    n_paired: n,
    baseline_pass_rate: n ? round4(bp / n) : 0,
    candidate_pass_rate: n ? round4(cp / n) : 0,
    delta: n ? round4((cp - bp) / n) : 0,
    mcnemar: mcnemar(onlyBase, onlyCand),
    hard_violations: { baseline: hard(base), candidate: hard(cand) },
    gate,
    reasons,
  };
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
