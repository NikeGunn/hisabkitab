/**
 * Legal disclaimer surfaced at signup (P15, PRD v2.0 §9). Locks in that the
 * auditor disclaimer exists and is delivered in the paired welcome, so it can't be
 * silently dropped. No DB / network — a pure string contract.
 */
import { describe, expect, it } from 'vitest';
import { AUDITOR_DISCLAIMER, pairedWelcome } from '../src/onboarding/pairing.js';

describe('auditor disclaimer', () => {
  it('states it is not a substitute for a licensed auditor and no statutory sign-off', () => {
    expect(AUDITOR_DISCLAIMER).toMatch(/not a substitute for a licensed auditor/i);
    expect(AUDITOR_DISCLAIMER).toMatch(/statutory sign-off/i);
    expect(AUDITOR_DISCLAIMER).toMatch(/file with the IRD yourself/i);
  });

  it('PROBE: the paired welcome (signup) actually carries the disclaimer', () => {
    const welcome = pairedWelcome('Test Pasal');
    expect(welcome).toContain(AUDITOR_DISCLAIMER);
  });
});
