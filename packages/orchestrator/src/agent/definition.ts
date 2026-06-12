/**
 * Managed Agents agent definition (PRD v1.0 §6 / v1.1 Phase 2).
 * The agent is a persisted, versioned object — created ONCE by setup.ts, referenced
 * by ID per session. model/system/tools live here, never on the session.
 */
import { SYSTEM_PROMPT } from './system-prompt.js';

/** Reasoning quality matters for money (v1.0 §6); downshift only after evals. */
export const HISAB_MODEL = 'claude-opus-4-8';
export const LEDGER_MCP_NAME = 'ledger';

export interface SkillRefs {
  nepalVat: string;
  nepalTds: string;
  billExtraction: string;
}

export interface AgentConfigInput {
  ledgerMcpUrl: string;
  skillIds: SkillRefs;
}

export function buildAgentConfig(input: AgentConfigInput) {
  const url = new URL(input.ledgerMcpUrl); // throws on garbage
  if (url.protocol !== 'https:') {
    throw new Error(`ledger MCP URL must be https (got ${url.protocol}//) — tokens travel on it`);
  }
  return {
    name: 'HisabKitab Bookkeeper',
    description:
      'WhatsApp-first bookkeeping & VAT/TDS assistant for one small Nepali business per session. ' +
      'Never guesses, never saves without owner confirmation, never files with the government.',
    model: HISAB_MODEL,
    system: SYSTEM_PROMPT,
    tools: [
      // bash + file ops (build PDFs, parse files), web_search/web_fetch (confirm IRD deadlines)
      { type: 'agent_toolset_20260401' as const, default_config: { enabled: true } },
      {
        type: 'mcp_toolset' as const,
        mcp_server_name: LEDGER_MCP_NAME,
        // These are OUR tenant-scoped tools; owner-level consent lives in the
        // tool semantics (draft→confirm_entry), not in per-call confirmations.
        // Without this the toolset defaults to always_ask and every ledger
        // call stalls the session waiting for a user.tool_confirmation.
        default_config: { enabled: true, permission_policy: { type: 'always_allow' as const } },
      },
    ],
    mcp_servers: [
      // No auth here — per-tenant signed bearer tokens live in vaults, attached per session.
      { type: 'url' as const, name: LEDGER_MCP_NAME, url: input.ledgerMcpUrl },
    ],
    skills: [
      { type: 'custom' as const, skill_id: input.skillIds.nepalVat, version: 'latest' },
      { type: 'custom' as const, skill_id: input.skillIds.nepalTds, version: 'latest' },
      { type: 'custom' as const, skill_id: input.skillIds.billExtraction, version: 'latest' },
    ],
    metadata: { project: 'hisabkitab', phase: '2' },
  };
}
