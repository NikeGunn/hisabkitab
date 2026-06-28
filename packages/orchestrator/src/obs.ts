/**
 * Orchestrator observability (P14 §8). One process-wide registry + root logger,
 * built from the shared pure obs core. The router/session/scheduler all take a
 * `Logger` + `BoundMetrics` so a single correlation id (the inbound wa_message_id)
 * threads WhatsApp msg → session turn → MCP call → audit row.
 *
 * Kept deliberately thin: all the logic lives in `@hisab/shared/obs` (DRY,
 * unit-tested there). This file only wires the singletons for the service.
 */
import {
  MetricsRegistry,
  bindMetrics,
  createLogger,
  type BoundMetrics,
  type Logger,
} from '@hisab/shared';

export const metricsRegistry = new MetricsRegistry();
export const metrics: BoundMetrics = bindMetrics(metricsRegistry);
export const rootLogger: Logger = createLogger('orchestrator');

/**
 * Per-message observability context, threaded through the router. `log` is a child
 * logger already tagged with the correlation id (+ tenant once known); `metrics`
 * is the shared registry. Passing this one object keeps call sites tidy.
 */
export interface ObsCtx {
  correlationId: string;
  log: Logger;
  metrics: BoundMetrics;
}

/** Build the obs context for one inbound message, tagged by its correlation id. */
export function inboundCtx(correlationId: string): ObsCtx {
  return {
    correlationId,
    log: rootLogger.child({ correlation_id: correlationId }),
    metrics,
  };
}
