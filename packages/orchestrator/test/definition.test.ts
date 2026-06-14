/**
 * Agent definition + system prompt invariants, incl. the PROBE that a non-https
 * ledger URL (tokens travel on it) must be rejected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAgentConfig,
  DEFAULT_HISAB_MODEL,
  DEV_HISAB_MODEL,
  HISAB_MODEL,
  LEDGER_MCP_NAME,
  PAYMENTS_MCP_NAME,
} from '../src/agent/definition.js';
import { SYSTEM_PROMPT, PRODUCT_NAME } from '../src/agent/system-prompt.js';

const skillIds = {
  nepalVat: 'skill_a',
  nepalTds: 'skill_b',
  billExtraction: 'skill_c',
  nepalPayments: 'skill_d',
  accountsReports: 'skill_e',
};

describe('model is config, not a literal (dev = cheap, prod = Opus)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to the production money-grade model when HISAB_MODEL is unset', async () => {
    vi.stubEnv('HISAB_MODEL', '');
    vi.resetModules();
    const m = await import('../src/agent/definition.js');
    expect(m.HISAB_MODEL).toBe(DEFAULT_HISAB_MODEL);
    expect(m.HISAB_MODEL).toBe('claude-opus-4-8');
  });

  it('uses the cheap dev model when HISAB_MODEL=claude-sonnet-4-6 (low dev cost)', async () => {
    vi.stubEnv('HISAB_MODEL', DEV_HISAB_MODEL);
    vi.resetModules();
    const m = await import('../src/agent/definition.js');
    expect(m.HISAB_MODEL).toBe('claude-sonnet-4-6');
    const cfg = m.buildAgentConfig({ ledgerMcpUrl: 'https://ledger.example/mcp', skillIds });
    expect(cfg.model).toBe('claude-sonnet-4-6');
  });
});

describe('buildAgentConfig', () => {
  it('wires model, prompt, ledger MCP and the five skills', () => {
    const cfg = buildAgentConfig({ ledgerMcpUrl: 'https://ledger.example/mcp', skillIds });
    expect(cfg.model).toBe(HISAB_MODEL);
    expect(cfg.system).toBe(SYSTEM_PROMPT);
    expect(cfg.mcp_servers).toEqual([
      { type: 'url', name: LEDGER_MCP_NAME, url: 'https://ledger.example/mcp' },
    ]);
    expect(cfg.skills.map((s) => s.skill_id)).toEqual(['skill_a', 'skill_b', 'skill_c', 'skill_d', 'skill_e']);
    expect(cfg.tools).toContainEqual({
      type: 'mcp_toolset',
      mcp_server_name: LEDGER_MCP_NAME,
      // always_allow: ledger tools are first-party; consent = draft->confirm_entry
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
    });
  });

  it('omits the payments MCP when no paymentsMcpUrl (pre-Phase-5 setups)', () => {
    const cfg = buildAgentConfig({ ledgerMcpUrl: 'https://ledger.example/mcp', skillIds });
    expect(cfg.mcp_servers.some((s) => s.name === PAYMENTS_MCP_NAME)).toBe(false);
    expect(cfg.tools.some((t) => 'mcp_server_name' in t && t.mcp_server_name === PAYMENTS_MCP_NAME)).toBe(
      false,
    );
  });

  it('wires the payments MCP + always_allow toolset when paymentsMcpUrl is given (Phase 5)', () => {
    const cfg = buildAgentConfig({
      ledgerMcpUrl: 'https://ledger.example/mcp',
      paymentsMcpUrl: 'https://pay.example/mcp',
      skillIds,
    });
    expect(cfg.mcp_servers).toContainEqual({
      type: 'url',
      name: PAYMENTS_MCP_NAME,
      url: 'https://pay.example/mcp',
    });
    expect(cfg.tools).toContainEqual({
      type: 'mcp_toolset',
      mcp_server_name: PAYMENTS_MCP_NAME,
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
    });
  });

  it('PROBE: rejects an http:// ledger URL (bearer tokens travel on it)', () => {
    expect(() => buildAgentConfig({ ledgerMcpUrl: 'http://ledger.example/mcp', skillIds })).toThrow(
      /https/,
    );
  });

  it('PROBE: rejects an http:// payments URL too (tokens travel on it)', () => {
    expect(() =>
      buildAgentConfig({
        ledgerMcpUrl: 'https://ledger.example/mcp',
        paymentsMcpUrl: 'http://pay.example/mcp',
        skillIds,
      }),
    ).toThrow(/https/);
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
