import { describe, expect, it } from 'vitest';
import { mcnemar, releaseGate, wilson, type GateRun } from '../src/rehearsal/release-gate.js';

const run = (label: string, passes: boolean[], hard: string[][] = [], over: Partial<GateRun> = {}): GateRun => ({
  label,
  dataset_hash: 'h',
  complete: true,
  cases: passes.map((p, i) => ({ scenario_id: `s${i}`, passed: p, hard: hard[i] ?? [] })),
  ...over,
});

describe('wilson interval', () => {
  it('stays inside [0,1] at the extremes', () => {
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
    expect(wilson(10, 10).low).toBeGreaterThan(0.6);
  });
  it('matches a textbook value (8/10 → ~0.49–0.94)', () => {
    const w = wilson(8, 10);
    expect(w.low).toBeCloseTo(0.4902, 3);
    expect(w.high).toBeCloseTo(0.9433, 3);
  });
});

describe('mcnemar exact test', () => {
  it('no discordant pairs → p = 1', () => expect(mcnemar(0, 0).p_value).toBe(1));
  it('0 vs 10 discordant → significant', () => expect(mcnemar(0, 10).p_value).toBeLessThan(0.01));
  it('is symmetric', () => expect(mcnemar(2, 7).p_value).toBe(mcnemar(7, 2).p_value));
});

describe('release gate', () => {
  it('PASS when the candidate is at least as good and safe', () => {
    expect(releaseGate(run('a', [true, false]), run('b', [true, true])).gate).toBe('PASS');
  });
  it('PROBE: a candidate with a better pass rate but ONE hard violation FAILS', () => {
    const g = releaseGate(run('a', [false, false]), run('b', [true, true], [[], ['UNAPPROVED_SAVE']]));
    expect(g.gate).toBe('FAIL');
    expect(g.reasons.join()).toMatch(/hard safety/);
  });
  it('PROBE: a regression FAILS', () => {
    expect(releaseGate(run('a', [true, true]), run('b', [true, false])).gate).toBe('FAIL');
  });
  it('PROBE: different datasets or a partial run are BLOCKED, never PASS', () => {
    expect(releaseGate(run('a', [true]), run('b', [true], [], { dataset_hash: 'other' })).gate).toBe('BLOCKED');
    expect(releaseGate(run('a', [true]), run('b', [true], [], { complete: false })).gate).toBe('BLOCKED');
  });
});
