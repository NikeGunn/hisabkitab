/** Orchestrator runtime config — zod on every external input, fail fast at boot. */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { IDS_FILE } from './agent/setup.js';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1), // hisab_orch connection
  LEDGER_MCP_URL: z.string().url(),
  TENANT_SIGNING_SECRET: z.string().min(8),
  AGENT_ID: z.string().optional(),
  ENVIRONMENT_ID: z.string().optional(),
  WA_PHONE_NUMBER_ID: z.string().min(1),
  WA_ACCESS_TOKEN: z.string().min(1),
  WA_WEBHOOK_VERIFY_TOKEN: z.string().min(8),
  WA_APP_SECRET: z.string().min(8),
  WA_GRAPH_BASE_URL: z.string().url().optional(), // stub override for verification
  PORT: z.coerce.number().int().positive().default(8810),
  // ---- Phase 6: reminder scheduler ----
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  // Run the BullMQ reminder worker in this process (set 0 on webhook-only nodes).
  SCHEDULER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== '0' && v?.toLowerCase() !== 'false'),
  REMINDER_CRON: z.string().optional(),
});

export type OrchestratorConfig = z.infer<typeof envSchema> & {
  AGENT_ID: string;
  ENVIRONMENT_ID: string;
};

/**
 * AGENT_ID/ENVIRONMENT_ID come from env, else from agent-ids.local.json (written
 * by `agent:setup`). In a container that file is absent: a missing file is NOT
 * fatal here (the server still boots and serves /healthz + the webhook handshake);
 * it only matters once a real agent turn runs. Treat empty strings as absent.
 */
export async function loadConfig(env = process.env): Promise<OrchestratorConfig> {
  const parsed = envSchema.parse(env);
  let agentId = parsed.AGENT_ID || undefined;
  let environmentId = parsed.ENVIRONMENT_ID || undefined;
  if (!agentId || !environmentId) {
    try {
      const ids = JSON.parse(await readFile(IDS_FILE, 'utf8')) as {
        agentId?: string;
        environmentId?: string;
      };
      agentId = agentId ?? ids.agentId;
      environmentId = environmentId ?? ids.environmentId;
    } catch {
      // No env vars and no ids file (e.g. fresh container). Boot anyway with
      // empty ids; run `agent:setup` or set AGENT_ID/ENVIRONMENT_ID to enable turns.
    }
  }
  return { ...parsed, AGENT_ID: agentId ?? '', ENVIRONMENT_ID: environmentId ?? '' };
}
