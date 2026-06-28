/**
 * Metrics registry (P14 obs). §8 discipline: happy path + adversarial probes
 * (counter can't go backwards; Prometheus format is exact; labels can't break it).
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from '../src/obs/index.js';

describe('Counter', () => {
  it('accumulates per labelset and is order-insensitive on labels', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('hisab_turns_total', 'agent turns');
    c.inc({ status: 'delivered' });
    c.inc({ status: 'delivered' }, 2);
    c.inc({ status: 'held' });
    expect(c.get({ status: 'delivered' })).toBe(3);
    expect(c.get({ status: 'held' })).toBe(1);
    // {a,b} and {b,a} must collapse to ONE series (sorted key).
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' });
    expect(c.get({ a: '1', b: '2' })).toBe(2);
  });

  it('PROBE: a counter rejects a negative increment (monotonic invariant)', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('x_total', 'x');
    expect(() => c.inc({}, -1)).toThrow(/cannot decrease/);
  });

  it('renders zero for an untouched counter (scrape always has the series)', () => {
    const reg = new MetricsRegistry();
    reg.counter('hisab_errors_total', 'errors');
    expect(reg.render()).toContain('hisab_errors_total 0');
  });
});

describe('Histogram', () => {
  it('produces cumulative le buckets + _sum + _count', () => {
    const reg = new MetricsRegistry();
    const h = reg.histogram('hisab_turn_latency_ms', 'turn latency', [100, 1000]);
    h.observe(50); // ≤100
    h.observe(500); // ≤1000
    h.observe(5000); // > last bucket → only +Inf
    const out = reg.render();
    expect(out).toContain('hisab_turn_latency_ms_bucket{le="100"} 1');
    expect(out).toContain('hisab_turn_latency_ms_bucket{le="1000"} 2'); // cumulative 50+500
    expect(out).toContain('hisab_turn_latency_ms_bucket{le="+Inf"} 3');
    expect(out).toContain('hisab_turn_latency_ms_sum 5550');
    expect(out).toContain('hisab_turn_latency_ms_count 3');
  });

  it('time() observes elapsed ms with an injected clock and returns the value', async () => {
    const reg = new MetricsRegistry();
    const h = reg.histogram('op_ms', 'op', [10, 100]);
    let t = 1000;
    const clock = () => t;
    const result = await h.time(
      async () => {
        t = 1042;
        return 'ok';
      },
      { kind: 'x' },
      clock,
    );
    expect(result).toBe('ok');
    expect(reg.render()).toContain('op_ms_sum{kind="x"} 42');
  });
});

describe('MetricsRegistry', () => {
  it('counter()/histogram() are idempotent factories (same name → same instrument)', () => {
    const reg = new MetricsRegistry();
    const a = reg.counter('dup_total', 'd');
    const b = reg.counter('dup_total', 'd');
    a.inc({}, 5);
    expect(b.get({})).toBe(5); // same underlying instrument
  });

  it('PROBE: label values with quotes/backslashes are escaped, not breaking the format', () => {
    const reg = new MetricsRegistry();
    reg.counter('msg_total', 'm').inc({ reason: 'said "hi"\\ok' });
    const out = reg.render();
    expect(out).toContain('reason="said \\"hi\\"\\\\ok"');
  });

  it('renders blocks sorted by metric name (stable scrape output)', () => {
    const reg = new MetricsRegistry();
    reg.counter('zzz_total', 'z').inc();
    reg.counter('aaa_total', 'a').inc();
    const out = reg.render();
    expect(out.indexOf('aaa_total')).toBeLessThan(out.indexOf('zzz_total'));
  });

  it('exposes the Prometheus content type', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toMatch(/text\/plain/);
  });
});
