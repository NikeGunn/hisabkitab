/**
 * Agent definition + system prompt invariants, incl. the PROBE that a non-https
 * ledger URL (tokens travel on it) must be rejected.
 */
import { describe, expect, it } from 'vitest';
import { buildAgentConfig, HISAB_MODEL, LEDGER_MCP_NAME } from '../src/agent/definition.js';
import { SYSTEM_PROMPT, PRODUCT_NAME } from '../src/agent/system-prompt.js';

const skillIds = { nepalVat: 'skill_a', nepalTds: 'skill_b', billExtraction: 'skill_c' };

describe('buildAgentConfig', () => {
  it('wires model, prompt, ledger MCP and the three skills', () => {
    const cfg = buildAgentConfig({ ledgerMcpUrl: 'https://ledger.example/mcp', skillIds });
    expect(cfg.model).toBe(HISAB_MODEL);
    expect(cfg.system).toBe(SYSTEM_PROMPT);
    expect(cfg.mcp_servers).toEqual([
      { type: 'url', name: LEDGER_MCP_NAME, url: 'https://ledger.example/mcp' },
    ]);
    expect(cfg.skills.map((s) => s.skill_id)).toEqual(['skill_a', 'skill_b', 'skill_c']);
    expect(cfg.tools).toContainEqual({
      type: 'mcp_toolset',
      mcp_server_name: LEDGER_MCP_NAME,
      // always_allow: ledger tools are first-party; consent = draft->confirm_entry
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
    });
  });

  it('PROBE: rejects an http:// ledger URL (bearer tokens travel on it)', () => {
    expect(() => buildAgentConfig({ ledgerMcpUrl: 'http://ledger.example/mcp', skillIds })).toThrow(
      /https/,
    );
  });

  it('PROBE: rejects a garbage URL', () => {
    expect(() => buildAgentConfig({ ledgerMcpUrl: 'not a url', skillIds })).toThrow();
  });
});

describe('system prompt (frozen, rule-bearing)', () => {
  it('contains the non-negotiable rules verbatim themes', () => {
    for (const must of [
      'NEVER guess',
      'explicit confirmation',
      'NEVER file with the government',
      'passwords, OTPs',
      'One session = one business',
    ]) {
      expect(SYSTEM_PROMPT).toContain(must);
    }
    expect(SYSTEM_PROMPT).toContain(PRODUCT_NAME);
  });

  it('is frozen — no timestamps/IDs interpolated (prompt-cache prefix discipline)', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamps
    expect(SYSTEM_PROMPT).not.toMatch(/sess?n?_|tenant_id/i);
  });
});
