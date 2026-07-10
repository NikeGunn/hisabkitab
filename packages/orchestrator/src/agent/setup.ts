/**
 * One-time setup (run rarely, never in the request path):
 *   skills → environment → agent. Idempotent by name; `--update` pushes a new
 *   agent version from the local definition; `--force-skills` pushes new skill
 *   versions. IDs are printed and written to agent-ids.local.json (gitignored).
 *
 *   pnpm --filter @hisab/orchestrator agent:setup
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { buildAgentConfig, type SkillRefs } from './definition.js';
import { syncSkills } from './skills.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILLS_ROOT = join(HERE, '..', '..', 'skills');
export const IDS_FILE = join(HERE, '..', '..', 'agent-ids.local.json');

export const ENVIRONMENT_NAME = 'hisabkitab';

export interface SetupResult {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  skillIds: SkillRefs;
}

export async function ensureEnvironment(client: Anthropic): Promise<string> {
  for await (const env of client.beta.environments.list()) {
    if (env.name === ENVIRONMENT_NAME) return env.id;
  }
  const created = await client.beta.environments.create({
    name: ENVIRONMENT_NAME,
    description: 'HisabKitab sessions: ledger MCP + web fetch (IRD deadline checks).',
    // Unrestricted egress for v1 (agent must reach the IRD site + ledger MCP).
    // Tighten to `limited` + allowed_hosts once the pilot host list is known.
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
    metadata: { project: 'hisabkitab' },
  });
  return created.id;
}

export async function ensureAgent(
  client: Anthropic,
  input: { ledgerMcpUrl: string; paymentsMcpUrl?: string; tallyMcpUrl?: string; skillIds: SkillRefs; update?: boolean },
): Promise<{ agentId: string; agentVersion: number }> {
  const config = buildAgentConfig({
    ledgerMcpUrl: input.ledgerMcpUrl,
    ...(input.paymentsMcpUrl ? { paymentsMcpUrl: input.paymentsMcpUrl } : {}),
    ...(input.tallyMcpUrl ? { tallyMcpUrl: input.tallyMcpUrl } : {}),
    skillIds: input.skillIds,
  });
  for await (const agent of client.beta.agents.list()) {
    if (agent.name === config.name) {
      if (input.update) {
        // optimistic lock: update against the current version
        const updated = await client.beta.agents.update(agent.id, { ...config, version: agent.version });
        return { agentId: updated.id, agentVersion: updated.version };
      }
      return { agentId: agent.id, agentVersion: agent.version };
    }
  }
  const created = await client.beta.agents.create(config);
  return { agentId: created.id, agentVersion: created.version };
}

export async function setup(
  client: Anthropic,
  opts: { ledgerMcpUrl: string; paymentsMcpUrl?: string; tallyMcpUrl?: string; update?: boolean; forceSkills?: boolean },
): Promise<SetupResult> {
  const skillIds = await syncSkills(client, SKILLS_ROOT, { forceNewVersion: opts.forceSkills });
  const environmentId = await ensureEnvironment(client);
  const agent = await ensureAgent(client, {
    ledgerMcpUrl: opts.ledgerMcpUrl,
    ...(opts.paymentsMcpUrl ? { paymentsMcpUrl: opts.paymentsMcpUrl } : {}),
    ...(opts.tallyMcpUrl ? { tallyMcpUrl: opts.tallyMcpUrl } : {}),
    skillIds,
    update: opts.update,
  });
  return { ...agent, environmentId, skillIds };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (isDirectRun) {
  const ledgerMcpUrl = process.env['LEDGER_MCP_URL'] ?? 'https://ledger.hisabkitab.example/mcp';
  if (!process.env['LEDGER_MCP_URL']) {
    console.warn(`LEDGER_MCP_URL not set — using placeholder ${ledgerMcpUrl} (fine pre-Phase-3).`);
  }
  const paymentsMcpUrl = process.env['PAYMENTS_MCP_URL'];
  if (!paymentsMcpUrl) {
    console.warn('PAYMENTS_MCP_URL not set — agent built WITHOUT the payments MCP (fine pre-Phase-5).');
  }
  const tallyMcpUrl = process.env['TALLY_MCP_URL'];
  if (!tallyMcpUrl) {
    console.warn('TALLY_MCP_URL not set — agent built WITHOUT the Tally MCP (fine for non-Tally pilots).');
  }
  const client = new Anthropic();
  const result = await setup(client, {
    ledgerMcpUrl,
    ...(paymentsMcpUrl ? { paymentsMcpUrl } : {}),
    ...(tallyMcpUrl ? { tallyMcpUrl } : {}),
    update: process.argv.includes('--update'),
    forceSkills: process.argv.includes('--force-skills'),
  });
  await writeFile(IDS_FILE, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved to ${IDS_FILE}`);
  console.log(`Console: https://platform.claude.com/workspaces/default/agents`);
}
