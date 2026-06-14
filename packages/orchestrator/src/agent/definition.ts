/**
 * Managed Agents agent definition (PRD v1.0 §6 / v1.1 Phase 2).
 * The agent is a persisted, versioned object — created ONCE by setup.ts, referenced
 * by ID per session. model/system/tools live here, never on the session.
 */
import { SYSTEM_PROMPT } from './system-prompt.js';

/**
 * Reasoning quality matters for money (v1.0 §6), so PRODUCTION pins Opus. But
 * Opus is costly to iterate on, so the model is config (HISAB_MODEL env), not a
 * literal: develop on cheap Sonnet, pin Opus for the pilot. Cost is a feature
 * (CLAUDE.md §3 / v2.0 §7).
 *   HISAB_MODEL=claude-sonnet-4-6  → dev / cheap
 *   HISAB_MODEL=claude-opus-4-8    → production money-grade reasoning (default)
 */
export const DEFAULT_HISAB_MODEL = 'claude-opus-4-8';
export const DEV_HISAB_MODEL = 'claude-sonnet-4-6';
export const HISAB_MODEL = process.env['HISAB_MODEL']?.trim() || DEFAULT_HISAB_MODEL;
export const LEDGER_MCP_NAME = 'ledger';
export const PAYMENTS_MCP_NAME = 'payments';

export interface SkillRefs {
  nepalVat: string;
  nepalTds: string;
  billExtraction: string;
  nepalPayments: string;
  accountsReports: string;
}

export interface AgentConfigInput {
  ledgerMcpUrl: string;
  /** Phase 5: Khalti payments MCP. Optional so pre-Phase-5 setups still work. */
  paymentsMcpUrl?: string;
  skillIds: SkillRefs;
}

function requireHttps(rawUrl: string, label: string): void {
  const url = new URL(rawUrl); // throws on garbage
  if (url.protocol !== 'https:') {
    throw new Error(`${label} MCP URL must be https (got ${url.protocol}//) — tokens travel on it`);
  }
}

export function buildAgentConfig(input: AgentConfigInput) {
  requireHttps(input.ledgerMcpUrl, 'ledger');
  if (input.paymentsMcpUrl) requireHttps(input.paymentsMcpUrl, 'payments');

  // A tenant-scoped MCP toolset: our tools, owner consent modeled in the tool
  // semantics (draft→confirm / owner_approved), so always_allow — otherwise the
  // toolset defaults to always_ask and every call stalls the session.
  const tenantToolset = (name: string) =>
    ({
      type: 'mcp_toolset' as const,
      mcp_server_name: name,
      default_config: { enabled: true, permission_policy: { type: 'always_allow' as const } },
    }) as const;
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
      tenantToolset(LEDGER_MCP_NAME),
      ...(input.paymentsMcpUrl ? [tenantToolset(PAYMENTS_MCP_NAME)] : []),
    ],
    mcp_servers: [
      // No auth here — per-tenant signed bearer tokens live in vaults, attached per session.
      { type: 'url' as const, name: LEDGER_MCP_NAME, url: input.ledgerMcpUrl },
      ...(input.paymentsMcpUrl
        ? [{ type: 'url' as const, name: PAYMENTS_MCP_NAME, url: input.paymentsMcpUrl }]
        : []),
    ],
    skills: [
      { type: 'custom' as const, skill_id: input.skillIds.nepalVat, version: 'latest' },
      { type: 'custom' as const, skill_id: input.skillIds.nepalTds, version: 'latest' },
      { type: 'custom' as const, skill_id: input.skillIds.billExtraction, version: 'latest' },
      { type: 'custom' as const, skill_id: input.skillIds.nepalPayments, version: 'latest' },
      { type: 'custom' as const, skill_id: input.skillIds.accountsReports, version: 'latest' },
    ],
    metadata: { project: 'hisabkitab', phase: '5' },
  };
}
