/**
 * In-process metrics registry (PRD v2.0 §8 — "Metrics: message latency, agent turn
 * latency, extraction-confirm rate, audit-gate hold rate, report reconcile-fail
 * rate, gateway success rate, per-tenant cost, queue depth, error rates"). PURE,
 * no IO: instruments accumulate in memory and render to Prometheus text exposition
 * via `render()`. A `GET /metrics` handler returns that string — scrapeable by
 * Prometheus later, `curl`-able today, with zero extra infrastructure to EMIT.
 *
 * Two instrument kinds cover everything §8 lists:
 *   - Counter   — monotonic totals (turns, gate holds, errors, reconcile fails).
 *   - Histogram — latency distributions (turn_latency_ms) → Prometheus buckets +
 *                 _sum/_count, which yields averages and quantiles at query time.
 *
 * Labels are low-cardinality by discipline (status, kind, service) — NEVER a
 * tenant_id or message id (that would explode series count). Per-tenant cost lives
 * in the P11 `usage_counters` table (queryable), not here.
 */

type Labels = Record<string, string>;

/** Stable key for a labelset: sorted so {a,b} and {b,a} collapse to one series. */
function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

/** Render a labelset as Prometheus `{k="v",…}` (empty → ''). Values are escaped. */
function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const inner = keys
    .map(
      (k) =>
        `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
  return `{${inner}}`;
}

interface CounterState {
  labels: Labels;
  value: number;
}

class Counter {
  private readonly series = new Map<string, CounterState>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  /** Add `amount` (default 1) to the series for these labels. Monotonic ≥ 0. */
  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new Error(`counter ${this.name} cannot decrease`);
    const key = labelKey(labels);
    const cur = this.series.get(key);
    if (cur) cur.value += amount;
    else this.series.set(key, { labels, value: amount });
  }

  get(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.series.size === 0) lines.push(`${this.name} 0`);
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }
}

/** Default latency buckets (ms) — tuned for chat turns (sub-second to multi-minute). */
export const DEFAULT_LATENCY_BUCKETS_MS = [
  50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];

interface HistogramState {
  labels: Labels;
  counts: number[]; // per-bucket cumulative is computed at render; this is per-bucket hits
  sum: number;
  count: number;
}

class Histogram {
  private readonly series = new Map<string, HistogramState>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: number[] = DEFAULT_LATENCY_BUCKETS_MS,
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        s.counts[i]! += 1;
        break; // store per-bucket hits; render accumulates into le-cumulative
      }
    }
  }

  /** Time a thunk and observe its duration in ms. Returns the thunk's result. */
  async time<T>(
    fn: () => Promise<T>,
    labels: Labels = {},
    now: () => number = Date.now,
  ): Promise<T> {
    const start = now();
    try {
      return await fn();
    } finally {
      this.observe(now() - start, labels);
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += s.counts[i]!;
        const le = { ...s.labels, le: String(this.buckets[i]) };
        lines.push(`${this.name}_bucket${renderLabels(le)} ${cumulative}`);
      }
      // +Inf bucket = total count (any value > last bucket lands only here).
      const inf = { ...s.labels, le: '+Inf' };
      lines.push(`${this.name}_bucket${renderLabels(inf)} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines;
  }
}

/**
 * A registry owns a service's instruments and renders them all. One per process.
 * `counter`/`histogram` are idempotent factories (same name → same instrument), so
 * call sites can fetch-or-create without a central declaration list.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help, buckets);
      this.histograms.set(name, h);
    }
    return h;
  }

  /** Prometheus text exposition for everything registered (stable, sorted by name). */
  render(): string {
    const blocks: string[] = [];
    for (const name of [...this.counters.keys()].sort())
      blocks.push(this.counters.get(name)!.render().join('\n'));
    for (const name of [...this.histograms.keys()].sort())
      blocks.push(this.histograms.get(name)!.render().join('\n'));
    return blocks.length ? `${blocks.join('\n')}\n` : '';
  }
}

export type { Counter, Histogram };
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Canonical instrument names (PRD v2.0 §8). Defined ONCE here so every service
 * references the same metric — no stringly-typed drift across orchestrator /
 * ledger / payments. `bindMetrics(registry)` returns typed accessors for them.
 */
export const METRIC = {
  inboundTotal: 'hisab_inbound_messages_total',
  turnTotal: 'hisab_agent_turns_total',
  turnLatencyMs: 'hisab_agent_turn_latency_ms',
  auditGateTotal: 'hisab_audit_gate_decisions_total',
  reportTotal: 'hisab_reports_total',
  gatewayTotal: 'hisab_gateway_calls_total',
  schedulerPassTotal: 'hisab_scheduler_pass_total',
  errorTotal: 'hisab_errors_total',
} as const;

/**
 * Bind the canonical §8 instruments on a registry and return typed helpers. This
 * is the ONE place a metric is created, so call sites stay declarative:
 *   metrics.turn({ status: 'delivered' }); metrics.turnLatency(842);
 * Reused identically by all three services (DRY).
 */
export function bindMetrics(reg: MetricsRegistry) {
  const inbound = reg.counter(METRIC.inboundTotal, 'inbound WhatsApp messages received');
  const turns = reg.counter(
    METRIC.turnTotal,
    'agent turns by outcome (delivered|held|timeout|error|trivial)',
  );
  const turnLatency = reg.histogram(METRIC.turnLatencyMs, 'agent turn latency in ms');
  const gate = reg.counter(METRIC.auditGateTotal, 'pre-delivery audit-gate decisions (pass|hold)');
  const reports = reg.counter(METRIC.reportTotal, 'report dispatches by verdict (pass|hold|fail)');
  const gateway = reg.counter(
    METRIC.gatewayTotal,
    'outbound gateway calls (whatsapp|khalti|anthropic) by result',
  );
  const schedulerPass = reg.counter(METRIC.schedulerPassTotal, 'scheduler passes by kind + result');
  const errors = reg.counter(METRIC.errorTotal, 'errors by component');
  return {
    registry: reg,
    inbound: (labels?: Labels) => inbound.inc(labels),
    turn: (labels: { status: string }) => turns.inc(labels),
    turnLatency: (ms: number, labels: Labels = {}) => turnLatency.observe(ms, labels),
    gate: (labels: { decision: 'pass' | 'hold' }) => gate.inc(labels),
    report: (labels: { verdict: string }) => reports.inc(labels),
    gateway: (labels: { target: string; result: 'ok' | 'error' }) => gateway.inc(labels),
    schedulerPass: (labels: { kind: string; result: 'ok' | 'error' }) => schedulerPass.inc(labels),
    error: (labels: { component: string }) => errors.inc(labels),
    render: () => reg.render(),
  };
}

export type BoundMetrics = ReturnType<typeof bindMetrics>;

/**
 * Framework-agnostic `/metrics` response (DRY across raw-http + Fastify services).
 * Returns the status, content type and body; each server adapts it to its own res.
 */
export function metricsResponse(reg: MetricsRegistry): {
  status: number;
  contentType: string;
  body: string;
} {
  return { status: 200, contentType: PROMETHEUS_CONTENT_TYPE, body: reg.render() };
}
