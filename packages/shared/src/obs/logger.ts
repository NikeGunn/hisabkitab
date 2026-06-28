/**
 * Structured JSON logger (PRD v2.0 §8 — "Structured logging (JSON) with a
 * correlation_id threaded WhatsApp msg → session → MCP call → DB"). PURE core:
 * the sink is injected, so the same logger is unit-testable (capture to an array),
 * runs to stdout in production, and never does IO of its own.
 *
 * One log line = one JSON object on one line, machine-parseable:
 *   {"ts":"…","level":"info","service":"orchestrator","correlation_id":"wamid…",
 *    "tenant_id":"…","msg":"turn delivered","latency_ms":842}
 *
 * Threading: `child()` returns a logger that carries extra base fields (typically
 * `correlation_id` + `tenant_id`), so once you bind a correlation id at ingress
 * every downstream line is automatically tagged — that is the whole point.
 *
 * Safety: every field value is passed through `redactValue` (obs/redact) so a PAN,
 * bearer token, or OTP can never reach the sink in the clear (closes the §9
 * "no secret in logs" gap).
 */
import { redactValue } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured fields attached to a line. Values are JSON-serialisable + redacted. */
export type LogFields = Record<string, unknown>;

/** One emitted record. The sink receives this fully-built, already-redacted. */
export interface LogRecord extends LogFields {
  ts: string;
  level: LogLevel;
  msg: string;
}

/** Where built records go. Production: write JSON to stdout. Tests: push to an array. */
export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  /** Minimum level emitted (default 'info'; set 'debug' via LOG_LEVEL=debug). */
  level?: LogLevel;
  /** Base fields stamped on every line (e.g. {service:'orchestrator'}). */
  base?: LogFields;
  /** Record sink. Default writes one JSON line to stdout. */
  sink?: LogSink;
  /** Clock (tests inject a fixed clock for deterministic `ts`). */
  now?: () => Date;
}

/** Default sink: one compact JSON line to stdout (12-factor; the platform ships it). */
export const stdoutSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export class Logger {
  private readonly level: LogLevel;
  private readonly base: LogFields;
  private readonly sink: LogSink;
  private readonly now: () => Date;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.base = opts.base ?? {};
    this.sink = opts.sink ?? stdoutSink;
    this.now = opts.now ?? (() => new Date());
  }

  /** Derive a logger that carries additional base fields (e.g. a correlation id). */
  child(fields: LogFields): Logger {
    return new Logger({
      level: this.level,
      base: { ...this.base, ...fields },
      sink: this.sink,
      now: this.now,
    });
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return; // below threshold → drop
    // Redact base + per-call fields together so a secret in EITHER is scrubbed.
    const merged = redactValue({ ...this.base, ...fields }) as LogFields;
    this.sink({ ts: this.now().toISOString(), level, msg: redactMsg(msg), ...merged });
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }
}

/** The message string is also redacted (callers sometimes interpolate values into it). */
function redactMsg(msg: string): string {
  return redactValue(msg);
}

/** Parse a level name from an env var, defaulting to 'info' on anything unknown. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v ?? '') ? (v as LogLevel) : 'info';
}

/** Build the root logger for a service (one place; reads LOG_LEVEL). */
export function createLogger(service: string, opts: LoggerOptions = {}): Logger {
  return new Logger({
    level: opts.level ?? parseLogLevel(process.env['LOG_LEVEL']),
    base: { service, ...opts.base },
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}
