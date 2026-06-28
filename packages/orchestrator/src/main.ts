/**
 * Production boot: config → db (hisab_orch) → WhatsApp client → webhook server.
 *   pnpm --filter @hisab/orchestrator start
 */
import Anthropic from '@anthropic-ai/sdk';
import { createDb } from '@hisab/db';
import { loadConfig } from './config.js';
import { DbGateLogger } from './audit/audit-logger.js';
import { WaClient } from './whatsapp/wa-client.js';
import { SerialQueues } from './whatsapp/router.js';
import { buildServer } from './server.js';
import { startScheduler, type SchedulerHandle } from './scheduler/queue.js';
import {
  createLedgerSummaryProvider,
  createTdsSummaryProvider,
} from './scheduler/ledger-summary.js';
import { TenantRateLimiter } from './resilience/rate-limit.js';
import { dispatchReport } from './reports/dispatch.js';
import { withTenant, appendAudit } from '@hisab/db';
import { HISAB_MODEL } from './agent/definition.js';
import { rootLogger, metrics } from './obs.js';

const config = await loadConfig();
const handle = createDb(config.DATABASE_URL);
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const wa = new WaClient({
  phoneNumberId: config.WA_PHONE_NUMBER_ID,
  accessToken: config.WA_ACCESS_TOKEN,
  ...(config.WA_GRAPH_BASE_URL ? { baseUrl: config.WA_GRAPH_BASE_URL } : {}),
});

const app = buildServer({
  verifyToken: config.WA_WEBHOOK_VERIFY_TOKEN,
  appSecret: config.WA_APP_SECRET,
  deps: {
    anthropic,
    db: handle.db,
    wa,
    gateLogger: new DbGateLogger(config.DATABASE_URL),
    queues: new SerialQueues(),
    rateLimiter: new TenantRateLimiter(), // per-tenant inbound cost guard
    // P11: per-tenant monthly budget + token accounting (runs as hisab_orch).
    costGuard: { db: handle.db, model: HISAB_MODEL },
    agentId: config.AGENT_ID,
    environmentId: config.ENVIRONMENT_ID,
    ledgerMcpUrl: config.LEDGER_MCP_URL,
    signingSecret: config.TENANT_SIGNING_SECRET,
    // Module C: render+reconcile+deliver PDF reports the agent requested this turn.
    dispatchReport: (tenantId, toE164, req) =>
      dispatchReport(
        {
          db: handle.db,
          ledgerMcpUrl: config.LEDGER_MCP_URL,
          signingSecret: config.TENANT_SIGNING_SECRET,
          delivery: {
            sendDocument: (to, bytes, filename, caption) =>
              wa.sendDocument(to, bytes, filename, caption),
            sendText: (to, body) => wa.sendText(to, body),
          },
          audit: {
            log: (entry) =>
              withTenant(handle.db, entry.tenantId, async (tx) => {
                await appendAudit(tx, entry.tenantId, {
                  actor: 'system',
                  action: entry.action,
                  detail: entry.detail,
                });
              }),
          },
          log: (msg) => rootLogger.info(msg, { component: 'reports' }),
        },
        tenantId,
        toE164,
        req,
      ),
    log: (msg) => rootLogger.debug(msg),
  },
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
rootLogger.info('orchestrator listening', {
  port: config.PORT,
  endpoints: ['/webhook', '/healthz', '/metrics'],
});

// Phase 6: monthly VAT-return reminder scheduler (BullMQ). Runs the worker in
// this process unless SCHEDULER_ENABLED=0 (webhook-only nodes).
let scheduler: SchedulerHandle | undefined;
if (config.SCHEDULER_ENABLED) {
  scheduler = await startScheduler({
    connection: { url: config.REDIS_URL },
    db: handle.db, // hisab_orch — cross-tenant, reminder_log writes
    getReturnSummary: createLedgerSummaryProvider({
      ledgerMcpUrl: config.LEDGER_MCP_URL,
      signingSecret: config.TENANT_SIGNING_SECRET,
    }),
    sendTemplate: (to, name, params) => wa.sendTemplate(to, name, params),
    // P10: subscription dunning runs in the same daily tick (cross-tenant, hisab_orch).
    dunning: {
      db: handle.db,
      sendTemplate: (to, name, params) => wa.sendTemplate(to, name, params),
      log: (msg) => schedLog('dunning', msg),
    },
    // P13: TDS-deposit reminder runs in the same daily tick (after the VAT reminder).
    tds: {
      db: handle.db,
      getTdsSummary: createTdsSummaryProvider({
        ledgerMcpUrl: config.LEDGER_MCP_URL,
        signingSecret: config.TENANT_SIGNING_SECRET,
      }),
      sendTemplate: (to, name, params) => wa.sendTemplate(to, name, params),
      log: (msg) => schedLog('tds', msg),
    },
    // Compliance-calendar digest runs in the same daily tick (once per BS month).
    calendar: {
      db: handle.db,
      sendTemplate: (to, name, params) => wa.sendTemplate(to, name, params),
      log: (msg) => schedLog('calendar', msg),
    },
    ...(config.REMINDER_CRON ? { cron: config.REMINDER_CRON } : {}),
    log: (msg) => schedLog('reminder', msg),
  });
  rootLogger.info('scheduler started', { passes: ['reminder', 'dunning', 'tds', 'calendar'] });
}

/**
 * One scheduler-pass log sink: structured line + a §8 pass metric. A line that
 * mentions "fail" is recorded as a failed pass so the metric reflects reliability.
 */
function schedLog(kind: string, msg: string): void {
  const result: 'ok' | 'error' = /\bfail/i.test(msg) ? 'error' : 'ok';
  metrics.schedulerPass({ kind, result });
  if (result === 'error') metrics.error({ component: `scheduler-${kind}` });
  rootLogger[result === 'error' ? 'warn' : 'info'](msg, { component: 'scheduler', pass: kind });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await scheduler?.close();
      await app.close();
      await handle.close();
      process.exit(0);
    })();
  });
}
