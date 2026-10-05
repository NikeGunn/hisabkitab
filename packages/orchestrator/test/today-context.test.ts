/** The agent has no clock; every turn carries today's Nepal date (AD + BS). */
import { describe, expect, it } from 'vitest';
import { todayContext } from '../src/whatsapp/router.js';

describe('todayContext', () => {
  it('uses Nepal time (UTC+5:45), not UTC, and includes the BS date', () => {
    // 2026-10-05 20:00 UTC is already 2026-10-06 01:45 in Kathmandu
    const s = todayContext(new Date('2026-10-05T20:00:00Z'));
    expect(s).toContain('AD 2026-10-06');
    expect(s).toMatch(/BS 2083-06-\d{2} \(Ashwin\)/);
  });
  it('PROBE: just before Nepal midnight stays on the same day', () => {
    expect(todayContext(new Date('2026-10-05T18:14:00Z'))).toContain('AD 2026-10-05');
  });
});
