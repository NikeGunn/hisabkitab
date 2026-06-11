/**
 * CI runs the SAME checks `pnpm verify` runs at runtime — one verdict taxonomy
 * (PASS|FAIL|BLOCKED|SKIP) shared by human + agent + CI (CLAUDE.md §8).
 */
import { describe, expect, it } from 'vitest';
import { checks } from '../src/verification/checks.js';
import { runCheck } from '../src/verification/verdict.js';

describe('verification registry', () => {
  const units = [...new Set(checks.map((c) => c.unit))];

  it('covers every Phase 0 unit', () => {
    expect(units.sort()).toEqual(['aging', 'bsdate', 'money', 'tds', 'validation', 'vat'].sort());
  });

  it('every unit ships at least one adversarial PROBE (no happy-path-only units)', () => {
    for (const unit of units) {
      const probes = checks.filter((c) => c.unit === unit && c.kind === 'probe');
      expect(probes.length, `unit "${unit}" has no adversarial probe`).toBeGreaterThanOrEqual(1);
    }
  });

  for (const check of checks) {
    it(`[${check.unit}/${check.kind}] ${check.name} → PASS`, () => {
      const result = runCheck(check);
      expect(result.verdict, result.detail).toBe('PASS');
    });
  }
});

describe('tax config', () => {
  it('loads verified FY 2082/83 defaults and accepts env overrides', async () => {
    const { loadTaxConfig, defaultTaxConfig } = await import('../src/config/tax.js');
    expect(defaultTaxConfig.vatRateBps).toBe(1300);
    expect(defaultTaxConfig.tdsServiceVatRegisteredBps).toBe(150);
    expect(defaultTaxConfig.contractTdsThresholdPaisa).toBe(5_000_000n);
    const overridden = loadTaxConfig({ VAT_RATE_BPS: '1500' });
    expect(overridden.vatRateBps).toBe(1500);
  });
});
