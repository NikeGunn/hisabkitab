/** Pure unit tests for per-tenant monthly budgets (PRD v2.0 §7). */
import { describe, expect, it } from 'vitest';
import {
  projectBudget,
  estimateCostPaisa,
  PLAN_BUDGET_PAISA,
  WARN_FRACTION,
} from '../src/index.js';

describe('projectBudget — verdict thresholds', () => {
  it('well under cap → OK', () => {
    const p = projectBudget('starter', { costPaisa: 10_000, turns: 5 });
    expect(p.verdict).toBe('OK');
    expect(p.capPaisa).toBe(PLAN_BUDGET_PAISA.starter);
    expect(p.remainingPaisa).toBe(PLAN_BUDGET_PAISA.starter - 10_000);
  });

  it('crossing the 80% soft-warn line → WARN', () => {
    const cap = PLAN_BUDGET_PAISA.starter;
    const justUnderWarn = Math.floor(cap * WARN_FRACTION) - 1;
    const atWarn = Math.ceil(cap * WARN_FRACTION);
    expect(projectBudget('starter', { costPaisa: justUnderWarn, turns: 1 }).verdict).toBe('OK');
    expect(projectBudget('starter', { costPaisa: atWarn, turns: 1 }).verdict).toBe('WARN');
  });

  it('PROBE: exactly AT the cap throttles (boundary, not >)', () => {
    const cap = PLAN_BUDGET_PAISA.pro;
    expect(projectBudget('pro', { costPaisa: cap - 1, turns: 1 }).verdict).toBe('WARN');
    expect(projectBudget('pro', { costPaisa: cap, turns: 1 }).verdict).toBe('THROTTLE');
    expect(projectBudget('pro', { costPaisa: cap + 5000, turns: 1 }).verdict).toBe('THROTTLE');
  });

  it('PROBE: an unknown plan falls back to the STRICTEST (starter) cap, never unlimited', () => {
    const p = projectBudget('enterprise-unlimited', { costPaisa: PLAN_BUDGET_PAISA.starter, turns: 1 });
    expect(p.capPaisa).toBe(PLAN_BUDGET_PAISA.starter);
    expect(p.verdict).toBe('THROTTLE');
  });

  it('remaining never goes negative; fraction can exceed 1', () => {
    const p = projectBudget('starter', { costPaisa: PLAN_BUDGET_PAISA.starter * 2, turns: 1 });
    expect(p.remainingPaisa).toBe(0);
    expect(p.fractionUsed).toBeGreaterThan(1);
  });

  it('negative/garbage spend is floored to 0 (OK)', () => {
    const p = projectBudget('business', { costPaisa: -999, turns: 0 });
    expect(p.spentPaisa).toBe(0);
    expect(p.verdict).toBe('OK');
  });
});

describe('estimateCostPaisa — conservative token costing', () => {
  it('costs input + output at the model rate, rounding UP', () => {
    // sonnet: 40_000 in / 200_000 out paisa per Mtok
    const c = estimateCostPaisa('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c).toBe(40_000 + 200_000);
  });

  it('rounds fractional paisa UP (never under-count)', () => {
    const c = estimateCostPaisa('claude-sonnet-4-6', { inputTokens: 1, outputTokens: 0 });
    expect(c).toBe(1); // 0.04 paisa → ceil → 1
  });

  it('PROBE: an unknown model uses the MOST EXPENSIVE rate (no sneaking past budget)', () => {
    const unknown = estimateCostPaisa('mystery-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const opus = estimateCostPaisa('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(unknown).toBe(opus);
  });

  it('negative token counts are floored to 0', () => {
    expect(estimateCostPaisa('claude-opus-4-8', { inputTokens: -5, outputTokens: -9 })).toBe(0);
  });
});
