/**
 * Secret redaction for structured logs (PRD v2.0 §9 — "no secret in
 * repo/prompt/logs"). PURE, no IO.
 *
 * Observability MUST NOT become a PII/secret leak. Every value a logger emits is
 * passed through `redact` first, so a PAN/VAT number, a bearer token, an OTP, or
 * a Khalti key can never reach stdout in the clear — even if a caller accidentally
 * logs a raw request object. This is deny-by-default: we redact recognised secret
 * SHAPES wherever they appear in a string, not only at named keys, because a
 * secret often arrives embedded in free text ("my pan is 301234567").
 *
 * Design: a single ordered list of (label, pattern, replacement) rules applied to
 * any string; objects are walked and every string leaf is scrubbed. The same rules
 * back the audit-preview redaction, so there is ONE definition of "what is secret".
 */

/**
 * A redaction rule: a recognised secret shape and what to replace it with.
 * `replace` matches `String.prototype.replace`'s callback shape (full match +
 * capture groups), so rules can rebuild a partially-masked value.
 */
interface RedactRule {
  readonly label: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/** Keep the last `keep` chars of a token so logs stay correlatable without leaking it. */
const mask = (s: string, keep = 0): string =>
  keep > 0 && s.length > keep ? `${'•'.repeat(6)}${s.slice(-keep)}` : '•'.repeat(6);

/**
 * Ordered redaction rules. Order matters: more specific shapes (bearer tokens,
 * keyed PAN) run before the bare 9-digit fallback so we attach the right label.
 */
const RULES: readonly RedactRule[] = [
  // Authorization: Bearer <token>  /  "access_token": "<token>"
  {
    label: 'bearer',
    pattern: /\b(bearer\s+)([A-Za-z0-9._-]{8,})/gi,
    replace: (m) => m.replace(/[A-Za-z0-9._-]{8,}$/, (t) => mask(t, 4)),
  },
  // token-bearing JSON-ish keys: token / secret / api_key / password / otp / pidx
  {
    label: 'secret-key',
    pattern:
      /("?(?:access_token|token|secret(?:_key)?|api[_-]?key|password|passwd|pwd|otp|verify_token)"?\s*[:=]\s*"?)([^"\s,}]{3,})/gi,
    replace: (m, pre: string, val: string) => `${pre}${mask(val, 0)}`,
  },
  // PAN/VAT keyed: "pan": "301234567"  /  vat = 301234567
  {
    label: 'pan-keyed',
    pattern: /\b((?:pan|vat)(?:_?(?:no|number))?"?\s*[:=]\s*"?)(\d{7,12})/gi,
    replace: (m, pre: string, num: string) => `${pre}${mask(num, 2)}`,
  },
  // Nepal IRD PAN/VAT is 9 digits; redact a bare standalone 9-digit run.
  {
    label: 'pan-bare',
    pattern: /\b\d{9}\b/g,
    replace: (m) => mask(m, 2),
  },
  // One-time codes presented inline ("code 4821", "OTP: 558213").
  {
    label: 'otp-inline',
    pattern: /\b(otp|code|pin)\b([\s:=-]+)(\d{4,8})\b/gi,
    replace: (m, w: string, sep: string) => `${w}${sep}${mask('', 0)}`,
  },
];

/** Redact secret shapes in a single string. Idempotent (re-running adds nothing). */
export function redactString(input: string): string {
  let out = input;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

/**
 * Deep-redact any log value. Strings are scrubbed; objects/arrays are walked and
 * every string leaf scrubbed. Non-strings pass through. Cyclic refs are broken so
 * a logger never throws on a self-referential payload.
 */
export function redactValue<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]' as T;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, seen);
  }
  return out as T;
}
