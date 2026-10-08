/**
 * Pure delivery policy for onboarding WhatsApp messages. No I/O: every decision
 * the tracker and the retrier make comes from here, so it is fully unit-tested.
 *
 *  - Status is a MAX-REGISTER over one total order
 *        accepted < sent < failed < delivered < read
 *    Meta's status webhooks arrive late, duplicated and out of order; merging is
 *    `max`, which is commutative, associative and idempotent, so ANY arrival order
 *    converges to the same state. `failed` sits below `delivered`: a receipt proves
 *    the owner got it, so it outranks a stray failure report.
 *  - Errors are classified by Meta code in O(1) (exact map + the 132xxx template
 *    range) into a SCOPE that decides what a retry can achieve.
 *  - Backoff is exponential with "equal jitter" seeded by the message key, so two
 *    failures never retry in lock-step yet every schedule is reproducible.
 */

export type DeliveryStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';

const RANK: Record<DeliveryStatus, number> = { accepted: 0, sent: 1, failed: 2, delivered: 3, read: 4 };

export function isDeliveryStatus(s: string): s is DeliveryStatus {
  return Object.prototype.hasOwnProperty.call(RANK, s);
}

/** Join of two observations of one message (lattice max). */
export function mergeStatus(current: DeliveryStatus, incoming: DeliveryStatus): DeliveryStatus {
  return RANK[incoming] > RANK[current] ? incoming : current;
}

/**
 * Who a failure is about, i.e. what retrying can fix:
 *   account    our WhatsApp account/billing (131042 payment): fixable by the
 *              operator, affects EVERY send → slow retries + one probe at a time
 *   transient  Meta/network hiccup or rate limit → retry soon
 *   template   the template is missing/paused/mis-filled → a different message
 *              (the verification code) can still get through
 *   recipient  the number itself cannot receive → retrying the same number is useless
 */
export type FailureScope = 'account' | 'transient' | 'template' | 'recipient';

const SCOPE_BY_CODE = new Map<number, FailureScope>([
  [131042, 'account'], // business eligibility payment issue
  [131031, 'account'], // business account locked
  [131057, 'account'], // business account in maintenance mode
  [133010, 'account'], // phone number not registered
  [131000, 'transient'], // something went wrong
  [131016, 'transient'], // service unavailable
  [133004, 'transient'], // server temporarily unavailable
  [130429, 'transient'], // rate limit hit
  [131048, 'transient'], // spam rate limit
  [131056, 'transient'], // pair rate limit
  [131049, 'transient'], // Meta held it back for ecosystem health; retry later
  [1, 'transient'],
  [2, 'transient'],
  [131026, 'recipient'], // undeliverable (no WhatsApp / old app / terms)
  [131021, 'recipient'], // recipient is our own number
  [131050, 'recipient'], // user stopped business messages
  [131047, 'recipient'], // outside the 24h window (never for templates)
  [131030, 'recipient'], // not in a test number's allow-list
]);

/** Unknown codes are treated as transient: retried, but bounded by MAX_ATTEMPTS. */
export function classifyFailure(code: number | null | undefined): FailureScope {
  if (code === null || code === undefined) return 'transient';
  const exact = SCOPE_BY_CODE.get(code);
  if (exact) return exact;
  if (code >= 132000 && code <= 132999) return 'template';
  return 'transient';
}

/** Total sends per onboarding (first try included). */
export const MAX_ATTEMPTS = 5;

const MINUTE = 60_000;
const BASE_MS: Record<'account' | 'transient', number> = { account: 10 * MINUTE, transient: 2 * MINUTE };
const CAP_MS = 2 * 60 * MINUTE;

/** FNV-1a: tiny, stable, well-spread 32-bit hash for the jitter seed. */
export function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type RetryDecision =
  | { kind: 'retry'; delayMs: number; scope: FailureScope }
  /** send a DIFFERENT message now (approval notice failed on its template → code) */
  | { kind: 'fallback'; scope: 'template' }
  | { kind: 'park'; scope: FailureScope; reason: 'recipient' | 'exhausted' | 'template' };

/**
 * What to do after attempt `attempt` (1-based) failed with `code`.
 * Exponential: base·3^(attempt-1), capped; equal jitter: d/2 + hash%(d/2).
 */
export function decideRetry(input: {
  code: number | null | undefined;
  attempt: number;
  kind: 'approval_notice' | 'approval_code' | 'admin_code' | 'signup_code';
  jitterKey: string;
}): RetryDecision {
  const scope = classifyFailure(input.code);
  if (scope === 'recipient') return { kind: 'park', scope, reason: 'recipient' };
  if (scope === 'template') {
    // the notice can fall back to a code; a code template that is broken cannot heal itself
    return input.kind === 'approval_notice' ? { kind: 'fallback', scope } : { kind: 'park', scope, reason: 'template' };
  }
  if (input.attempt >= MAX_ATTEMPTS) return { kind: 'park', scope, reason: 'exhausted' };
  const full = Math.min(CAP_MS, BASE_MS[scope] * 3 ** (input.attempt - 1));
  const half = Math.floor(full / 2);
  return { kind: 'retry', scope, delayMs: half + (fnv1a(input.jitterKey) % Math.max(1, half)) };
}

/** Owner-facing summary for the admin panel row. */
export function describeDelivery(row: {
  status: DeliveryStatus;
  errorCode: number | null;
  errorTitle: string | null;
  attempt: number;
  retryAt: Date | null;
}, now: Date): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  switch (row.status) {
    case 'read':
      return { text: 'Read by owner', tone: 'ok' };
    case 'delivered':
      return { text: 'Delivered', tone: 'ok' };
    case 'sent':
      return { text: 'Sent, not yet delivered', tone: 'muted' };
    case 'accepted':
      return { text: 'Accepted by WhatsApp', tone: 'muted' };
    case 'failed': {
      const why = `${row.errorCode ?? '?'}${row.errorTitle ? ` ${row.errorTitle}` : ''}`;
      if (row.retryAt) {
        const mins = Math.max(0, Math.ceil((row.retryAt.getTime() - now.getTime()) / MINUTE));
        return { text: `Not delivered (${why}). Auto-retry ${mins <= 0 ? 'now' : `in ${mins} min`}, attempt ${row.attempt + 1}/${MAX_ATTEMPTS}`, tone: 'warn' };
      }
      return { text: `Not delivered (${why}). Not retrying automatically`, tone: 'bad' };
    }
  }
}
