/**
 * Production boot: config → db (hisab_orch) → WhatsApp client → webhook server.
 *   pnpm --filter @hisab/orchestrator start
 */
import Anthropic from '@anthropic-ai/sdk';
import { createDb, SettingsCache } from '@hisab/db';
import type { PlanCode } from '@hisab/shared';
import { loadConfig } from './config.js';
import { DbGateLogger } from './audit/audit-logger.js';
import { WaClient } from './whatsapp/wa-client.js';
import { TemplateCategoryGuard, graphCategoryFetcher } from './whatsapp/category-guard.js';
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
import { registerSignup } from './signup/route.js';
import { registerAdmin, registerAdminDisabled } from './admin/routes.js';
import { AdminAuth } from './admin/auth.js';
import { startOutboxDrain } from './notify/outbox-drain.js';

const config = await loadConfig();
const handle = createDb(config.DATABASE_URL);
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// Runtime settings (admin panel) layered over env. Every WhatsApp send, webhook
// signature check and sender filter reads them per request, so swapping the
// number or rotating the token in the panel is live within seconds.
const settings = await new SettingsCache(handle.db, process.env, (err) =>
  rootLogger.error('settings refresh failed', { error: String(err) }),
).start(10_000);

// Never send a template Meta has re-categorised as MARKETING (billing guard).
const templateGuard = new TemplateCategoryGuard({
  fetchCategories: graphCategoryFetcher({
    creds: () => ({
      accessToken: settings.require('wa.access_token'),
      businessAccountId: settings.require('wa.business_account_id'),
    }),
    ...(config.WA_GRAPH_BASE_URL ? { baseUrl: config.WA_GRAPH_BASE_URL } : {}),
  }),
  scope: () => settings.get('wa.business_account_id') ?? '',
  onBlocked: (template) => {
    rootLogger.error('template send refused: Meta categorised it MARKETING', { component: 'billing-guard', template });
    metrics.error({ component: 'billing-guard' });
  },
  onLookupError: (err) =>
    rootLogger.warn('template categories unavailable; using last known', { component: 'billing-guard', error: String(err) }),
});

const wa = new WaClient({
  credentials: () => ({
    phoneNumberId: settings.require('wa.phone_number_id'),
    accessToken: settings.require('wa.access_token'),
  }),
  templateGuard,
  ...(config.WA_GRAPH_BASE_URL ? { baseUrl: config.WA_GRAPH_BASE_URL } : {}),
});

const signupLog = (msg: string, fields?: Record<string, unknown>) =>
  rootLogger.info(msg, { component: 'signup', ...(fields ?? {}) });

const app = buildServer({
  verifyToken: () => settings.require('wa.webhook_verify_token'),
  appSecret: () => settings.require('wa.app_secret'),
  // Only answer messages sent to OUR sender — the Meta app also serves other numbers.
  acceptsPhoneNumberId: (id) => id === settings.get('wa.phone_number_id'),
  register: (server) => {
    registerSignup(server, {
      db: handle.db,
      sendAuthCode: (to, template, code) => wa.sendAuthCode(to, template, code),
      sendTemplate: (to, template, params) => wa.sendTemplate(to, template, params),
      settings: {
        enabled: () => settings.bool('signup.enabled'),
        dailyCap: () => Number(settings.get('signup.daily_cap') ?? 0),
        senderE164: () => settings.get('wa.sender_e164') || undefined,
        alertE164: () => settings.get('signup.alert_e164') || undefined,
        requireApproval: () => settings.bool('signup.require_approval'),
      },
      log: signupLog,
    });
    if (config.ADMIN_PASSWORD_HASH) {
      registerAdmin(server, {
        db: handle.db,
        settings,
        auth: new AdminAuth(config.TENANT_SIGNING_SECRET, config.ADMIN_PASSWORD_HASH),
        sendAuthCode: (to, template, code) => wa.sendAuthCode(to, template, code),
        sendTemplate: (to, template, params, button) =>
          wa.sendTemplate(to, template, params, 'en', button ? { index: 0, param: button } : undefined),
        signingSecret: config.TENANT_SIGNING_SECRET,
        ...(config.PAYMENTS_INTERNAL_MCP_URL || config.PAYMENTS_MCP_URL
          ? { paymentsMcpUrl: (config.PAYMENTS_INTERNAL_MCP_URL || config.PAYMENTS_MCP_URL) as string }
          : {}),
        ...(config.WA_APP_ID ? { appId: config.WA_APP_ID } : {}),
        ...(config.WA_GRAPH_BASE_URL ? { graphBaseUrl: config.WA_GRAPH_BASE_URL } : {}),
        agentConfigured: Boolean(config.AGENT_ID && config.ENVIRONMENT_ID),
        model: HISAB_MODEL,
      });
    } else {
      registerAdminDisabled(server);
      rootLogger.warn('admin panel disabled: ADMIN_PASSWORD_HASH not set');
    }
  },
  deps: {
    trialPlan: () => (settings.get('signup.trial_plan') ?? 'pro') as PlanCode,
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
    mcpServerUrls: [
      config.LEDGER_MCP_URL,
      ...(config.PAYMENTS_MCP_URL ? [config.PAYMENTS_MCP_URL] : []),
      ...(config.TALLY_MCP_URL ? [config.TALLY_MCP_URL] : []),
    ],
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

// Transactional WhatsApp outbox (payment receipts queued by the payments service).
const stopOutbox = startOutboxDrain(
  handle.db,
  (to, template, params, button) =>
    wa.sendTemplate(to, template, params, 'en', button ? { index: 0, param: button } : undefined),
  (msg, fields) => rootLogger.info(msg, { component: 'outbox', ...(fields ?? {}) }),
);
rootLogger.info('orchestrator listening', {
  port: config.PORT,
  endpoints: ['/webhook', '/signup', '/admin', '/healthz', '/metrics'],
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
      stopOutbox();
      settings.stop();
      await scheduler?.close();
      await app.close();
      await handle.close();
      process.exit(0);
    })();
  });
}
