/**
 * Pure onboarding delivery policy. Invariants: status merge is a lattice join
 * (any arrival order / duplicates converge to the same state); a receipt always
 * beats a failure; backoff grows, is capped, and is reproducible per key.
 * PROBES: every permutation of a hostile status stream, an unknown error code,
 * a broken template on a code, exhausted attempts, jitter collisions.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  classifyFailure,
  decideRetry,
  describeDelivery,
  fnv1a,
  mergeStatus,
  type DeliveryStatus,
} from '../src/onboarding/delivery-policy.js';
import { messageIdOf } from '../src/whatsapp/wa-client.js';

const ALL: DeliveryStatus[] = ['accepted', 'sent', 'failed', 'delivered', 'read'];
const fold = (xs: DeliveryStatus[]) => xs.reduce(mergeStatus, 'accepted' as DeliveryStatus);

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe('mergeStatus (max-register)', () => {
  it('is commutative, associative and idempotent over every pair/triple', () => {
    for (const a of ALL)
      for (const b of ALL) {
        expect(mergeStatus(a, b)).toBe(mergeStatus(b, a));
        expect(mergeStatus(a, a)).toBe(a);
        for (const c of ALL) expect(mergeStatus(mergeStatus(a, b), c)).toBe(mergeStatus(a, mergeStatus(b, c)));
      }
  });

  it('PROBE: all 120 arrival orders of sent/failed/delivered/read/accepted converge to "read"', () => {
    const orders = permutations(ALL);
    expect(orders).toHaveLength(120);
    for (const o of orders) expect(fold(o)).toBe('read');
  });

  it('PROBE: duplicated + reordered webhooks never move a status backwards', () => {
    expect(fold(['read', 'sent', 'sent', 'accepted'])).toBe('read');
    expect(fold(['delivered', 'failed'])).toBe('delivered'); // receipt beats a stray failure
    expect(fold(['failed', 'delivered'])).toBe('delivered');
    expect(fold(['sent', 'failed', 'sent'])).toBe('failed');
  });
});

describe('classifyFailure', () => {
  it('maps Meta codes to the right scope in O(1)', () => {
    expect(classifyFailure(131042)).toBe('account'); // the 2026-10-08 incident
    expect(classifyFailure(131026)).toBe('recipient');
    expect(classifyFailure(130429)).toBe('transient');
    expect(classifyFailure(132001)).toBe('template');
    expect(classifyFailure(132015)).toBe('template');
  });
  it('PROBE: unknown / missing codes are transient (retried, but bounded)', () => {
    expect(classifyFailure(999_999)).toBe('transient');
    expect(classifyFailure(undefined)).toBe('transient');
    expect(classifyFailure(null)).toBe('transient');
  });
});

describe('decideRetry', () => {
  const base = { kind: 'approval_code' as const, jitterKey: 'wamid.X' };

  it('131042 retries on the slow account schedule (5..10 min first, growing, capped at 2h)', () => {
    const delays = [1, 2, 3, 4].map((attempt) => {
      const d = decideRetry({ ...base, code: 131042, attempt });
      expect(d.kind).toBe('retry');
      return (d as { delayMs: number }).delayMs;
    });
    expect(delays[0]).toBeGreaterThanOrEqual(5 * 60_000);
    expect(delays[0]).toBeLessThan(10 * 60_000);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(Math.max(...delays)).toBeLessThan(2 * 60 * 60_000);
  });

  it('transient errors retry sooner than account errors', () => {
    const t = decideRetry({ ...base, code: 131000, attempt: 1 }) as { delayMs: number };
    expect(t.delayMs).toBeGreaterThanOrEqual(60_000);
    expect(t.delayMs).toBeLessThan(2 * 60_000);
  });

  it('PROBE: a number that cannot receive is parked, never retried', () => {
    expect(decideRetry({ ...base, code: 131026, attempt: 1 })).toEqual({ kind: 'park', scope: 'recipient', reason: 'recipient' });
  });

  it('a broken approval-notice template falls back to the code; a broken code template parks', () => {
    expect(decideRetry({ ...base, kind: 'approval_notice', code: 132001, attempt: 1 })).toEqual({ kind: 'fallback', scope: 'template' });
    expect(decideRetry({ ...base, code: 132001, attempt: 1 })).toMatchObject({ kind: 'park', reason: 'template' });
  });

  it(`PROBE: attempt ${MAX_ATTEMPTS} is the last one, whatever the error`, () => {
    expect(decideRetry({ ...base, code: 131042, attempt: MAX_ATTEMPTS })).toMatchObject({ kind: 'park', reason: 'exhausted' });
    expect(decideRetry({ ...base, code: 999_999, attempt: MAX_ATTEMPTS + 3 })).toMatchObject({ kind: 'park', reason: 'exhausted' });
  });

  it('PROBE: jitter is deterministic per key yet spreads 200 keys over many distinct slots', () => {
    const one = decideRetry({ ...base, code: 131000, attempt: 2 });
    expect(decideRetry({ ...base, code: 131000, attempt: 2 })).toEqual(one);
    const slots = new Set(
      Array.from({ length: 200 }, (_, i) => (decideRetry({ ...base, jitterKey: `wamid.${i}`, code: 131000, attempt: 2 }) as { delayMs: number }).delayMs),
    );
    expect(slots.size).toBeGreaterThan(190);
    expect(fnv1a('')).toBe(0x811c9dc5);
  });
});

describe('describeDelivery', () => {
  const now = new Date('2026-10-08T14:20:00Z');
  it('explains each state for the admin row', () => {
    const row = { errorCode: null, errorTitle: null, attempt: 1, retryAt: null };
    expect(describeDelivery({ ...row, status: 'read' }, now)).toEqual({ text: 'Read by owner', tone: 'ok' });
    expect(describeDelivery({ ...row, status: 'delivered' }, now).tone).toBe('ok');
    expect(
      describeDelivery({ status: 'failed', errorCode: 131042, errorTitle: 'Business eligibility payment issue', attempt: 1, retryAt: new Date('2026-10-08T14:27:30Z') }, now),
    ).toEqual({ text: 'Not delivered (131042 Business eligibility payment issue). Auto-retry in 8 min, attempt 2/5', tone: 'warn' });
    expect(describeDelivery({ status: 'failed', errorCode: 131026, errorTitle: null, attempt: 1, retryAt: null }, now)).toEqual({
      text: 'Not delivered (131026). Not retrying automatically',
      tone: 'bad',
    });
  });
});

describe('messageIdOf (Graph /messages response)', () => {
  it('extracts the wamid; PROBE: garbage, empty and oversized ids are rejected', () => {
    expect(messageIdOf({ messages: [{ id: 'wamid.HBgN' }] })).toBe('wamid.HBgN');
    expect(messageIdOf(null)).toBeUndefined();
    expect(messageIdOf({ messages: [] })).toBeUndefined();
    expect(messageIdOf({ messages: [{ id: 42 }] })).toBeUndefined();
    expect(messageIdOf({ messages: [{ id: '' }] })).toBeUndefined();
    expect(messageIdOf({ messages: [{ id: 'x'.repeat(300) }] })).toBeUndefined();
  });
});
