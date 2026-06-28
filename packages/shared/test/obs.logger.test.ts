/**
 * Logger + redaction (P14 obs). §8 discipline: each unit ships a happy path AND
 * at least one adversarial PROBE — here, secrets that MUST NOT reach the sink.
 */
import { describe, it, expect } from 'vitest';
import {
  Logger,
  createLogger,
  parseLogLevel,
  redactString,
  redactValue,
  type LogRecord,
} from '../src/obs/index.js';

/** Capture-to-array sink + a fixed clock → fully deterministic assertions. */
function capture() {
  const records: LogRecord[] = [];
  const log = new Logger({
    base: { service: 'test' },
    level: 'debug',
    sink: (r) => records.push(r),
    now: () => new Date('2026-06-28T00:00:00.000Z'),
  });
  return { log, records };
}

describe('redactString — secret shapes never survive', () => {
  it('PROBE: redacts a bearer token but keeps a correlatable tail', () => {
    const out = redactString('Authorization: Bearer abcDEF123456ghingXYZ');
    expect(out).not.toContain('abcDEF123456');
    expect(out).toMatch(/Bearer •+/);
  });

  it('PROBE: redacts a keyed secret (access_token / api_key / password)', () => {
    expect(redactString('"access_token":"EAAJsystemusertoken"')).not.toContain(
      'EAAJsystemusertoken',
    );
    expect(redactString('api_key=sk_live_9911')).not.toContain('sk_live_9911');
    expect(redactString('password: hunter2pass')).not.toContain('hunter2pass');
  });

  it('PROBE: redacts a bare 9-digit Nepal PAN and a keyed PAN', () => {
    expect(redactString('my pan is 301234567 ok')).not.toContain('301234567');
    expect(redactString('"pan":"309876543"')).not.toContain('309876543');
  });

  it('PROBE: redacts an inline OTP/code', () => {
    expect(redactString('your OTP: 558213')).not.toContain('558213');
    expect(redactString('code 4821')).not.toContain('4821');
  });

  it('is idempotent (re-redacting adds nothing)', () => {
    const once = redactString('Bearer abcDEF123456ghing');
    expect(redactString(once)).toBe(once);
  });

  it('leaves ordinary text and amounts untouched', () => {
    expect(redactString('paid 5000 to ram for stock')).toBe('paid 5000 to ram for stock');
  });
});

describe('redactValue — deep walk', () => {
  it('scrubs string leaves in nested objects/arrays', () => {
    const out = redactValue({
      tok: 'Bearer secretTokenValue',
      nested: [{ pan: '301234567' }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('secretTokenValue');
    expect(JSON.stringify(out)).not.toContain('301234567');
  });

  it('PROBE: does not throw on a cyclic object', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a['self'] = a;
    expect(() => redactValue(a)).not.toThrow();
  });

  it('passes non-strings (numbers/bools/null) through', () => {
    expect(redactValue({ n: 42, b: true, z: null })).toEqual({ n: 42, b: true, z: null });
  });
});

describe('Logger', () => {
  it('emits one JSON record with base + per-call fields', () => {
    const { log, records } = capture();
    log.info('turn delivered', { latency_ms: 842 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ts: '2026-06-28T00:00:00.000Z',
      level: 'info',
      service: 'test',
      msg: 'turn delivered',
      latency_ms: 842,
    });
  });

  it('child() carries correlation_id + tenant_id onto every later line', () => {
    const { log, records } = capture();
    const child = log.child({ correlation_id: 'wamid.HBgM', tenant_id: 't1' });
    child.warn('budget WARN');
    expect(records[0]).toMatchObject({
      correlation_id: 'wamid.HBgM',
      tenant_id: 't1',
      level: 'warn',
    });
  });

  it('PROBE: drops lines below the configured level', () => {
    const records: LogRecord[] = [];
    const log = new Logger({ level: 'warn', sink: (r) => records.push(r) });
    log.info('should not appear');
    log.debug('nor this');
    log.error('but this does');
    expect(records.map((r) => r.level)).toEqual(['error']);
  });

  it('PROBE: a secret passed in fields OR the message is redacted at the sink', () => {
    const { log, records } = capture();
    log.info('sending Bearer abcDEF123456token', {
      authorization: 'Bearer abcDEF123456token',
      pan: '301234567',
    });
    const line = JSON.stringify(records[0]);
    expect(line).not.toContain('abcDEF123456token');
    expect(line).not.toContain('301234567');
  });
});

describe('parseLogLevel / createLogger', () => {
  it('parses known levels and defaults unknowns to info', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('LOUD')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('createLogger stamps the service name', () => {
    const records: LogRecord[] = [];
    const log = createLogger('orchestrator', { sink: (r) => records.push(r), level: 'info' });
    log.info('boot');
    expect(records[0]).toMatchObject({ service: 'orchestrator', msg: 'boot' });
  });
});
