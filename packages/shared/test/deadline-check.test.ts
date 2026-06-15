/**
 * Governed IRD-deadline web-verification (PRD v1.1 §5). The headline guarantee:
 * a web result can CONFIRM the computed deadline but NEVER silently replace it.
 */
import { describe, expect, it } from 'vitest';
import { checkFilingDeadline } from '../src/index.js';

const COMPUTED = '2026-08-10';

describe('checkFilingDeadline', () => {
  it('PASS when the IRD source confirms the computed date', () => {
    const r = checkFilingDeadline(COMPUTED, { observedAdIso: COMPUTED, sourceUrl: 'https://ird.gov.np/calendar' });
    expect(r.verdict).toBe('PASS');
    expect(r.computedAdIso).toBe(COMPUTED);
    expect(r.source).toBe('https://ird.gov.np/calendar');
  });

  it('SKIP (still usable) when no web observation is supplied', () => {
    const r = checkFilingDeadline(COMPUTED);
    expect(r.verdict).toBe('SKIP');
    expect(r.computedAdIso).toBe(COMPUTED); // caller still proceeds on the computed value
    expect(r.detail).toMatch(/not web-confirmed/);
  });

  it('PROBE: a DISAGREEING web date BLOCKS — it never overwrites the computed deadline', () => {
    const r = checkFilingDeadline(COMPUTED, { observedAdIso: '2026-08-05', sourceUrl: 'https://ird.gov.np/x' });
    expect(r.verdict).toBe('BLOCKED');
    // critical: the computed value is preserved, the web value is NOT adopted
    expect(r.computedAdIso).toBe(COMPUTED);
    expect(r.detail).not.toContain('2026-08-05 is the deadline');
    expect(r.detail).toMatch(/Holding/);
  });

  it('PROBE: an unreadable web date BLOCKS (couldn\'t confirm ≠ wrong)', () => {
    const r = checkFilingDeadline(COMPUTED, { observedAdIso: 'sometime in Bhadra', sourceUrl: 'https://ird.gov.np' });
    expect(r.verdict).toBe('BLOCKED');
    expect(r.computedAdIso).toBe(COMPUTED);
  });

  it('PROBE: a malformed COMPUTED date BLOCKS (programming error, not a web problem)', () => {
    expect(checkFilingDeadline('10/08/2026').verdict).toBe('BLOCKED');
  });
});
