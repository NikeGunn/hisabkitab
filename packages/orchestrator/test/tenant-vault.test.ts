/**
 * Vault bearer minting: the token the vault injects must round-trip through the
 * Ledger MCP's verifier. PROBE: wrong secret / wrong tenant must be rejected.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { verifyTenantToken, AuthError } from '@hisab/mcp-ledger';
import { ensureTenantVault, mintLedgerBearer, tenantVaultName } from '../src/vault/tenant-vault.js';

const TENANT = '7b39c2a4-1f7e-4d2a-9c1b-2f6e8a0d4c11';
const OPTS = {
  tenantId: TENANT,
  ledgerMcpUrl: 'https://ledger.example/mcp',
  signingSecret: 'test-secret',
};

describe('mintLedgerBearer', () => {
  it('round-trips through the MCP verifier and scopes to the tenant (default owner)', () => {
    expect(verifyTenantToken(mintLedgerBearer(OPTS), 'test-secret')).toEqual({
      tenantId: TENANT,
      role: 'owner',
    });
  });

  it('carries the acting role into the bearer (RBAC, PRD §3)', () => {
    const bearer = mintLedgerBearer({ ...OPTS, role: 'staff' });
    expect(verifyTenantToken(bearer, 'test-secret')).toMatchObject({
      tenantId: TENANT,
      role: 'staff',
    });
  });

  it('PROBE: a token signed with another secret is rejected', () => {
    expect(() => verifyTenantToken(mintLedgerBearer(OPTS), 'other-secret')).toThrow(AuthError);
  });

  it('PROBE: an expired token is rejected', () => {
    const expired = mintLedgerBearer({ ...OPTS, ttlSeconds: -10 });
    expect(() => verifyTenantToken(expired, 'test-secret')).toThrow(/expired/);
  });

  it('vault name is deterministic per tenant', () => {
    expect(tenantVaultName(TENANT)).toBe(`hisab-tenant-${TENANT}`);
  });

  it('creates and rotates a separate exact-URL credential for every configured MCP', async () => {
    const stored: Array<{
      id: string;
      auth: { type: 'static_bearer'; mcp_server_url: string };
    }> = [];
    const created: Array<{ url: string; token: string }> = [];
    const updated: Array<{ id: string; token: string }> = [];

    const client = {
      beta: {
        vaults: {
          list: async function* () {
            yield { id: 'vault-1', display_name: tenantVaultName(TENANT) };
          },
          create: async () => ({ id: 'unexpected-vault' }),
          credentials: {
            list: async function* () {
              yield* stored;
            },
            create: async (
              _vaultId: string,
              input: {
                auth: { type: 'static_bearer'; mcp_server_url: string; token: string };
              },
            ) => {
              const id = `credential-${stored.length + 1}`;
              stored.push({
                id,
                auth: {
                  type: 'static_bearer',
                  mcp_server_url: input.auth.mcp_server_url,
                },
              });
              created.push({ url: input.auth.mcp_server_url, token: input.auth.token });
              return { id };
            },
            update: async (
              id: string,
              input: { auth: { type: 'static_bearer'; token: string } },
            ) => {
              updated.push({ id, token: input.auth.token });
              return { id };
            },
          },
        },
      },
    } as unknown as Anthropic;

    const urls = [
      OPTS.ledgerMcpUrl,
      'https://api.example/payments/mcp',
      'https://api.example/tally/mcp',
      OPTS.ledgerMcpUrl,
    ];
    const first = await ensureTenantVault(client, { ...OPTS, mcpServerUrls: urls });

    expect(first).toEqual({
      vaultId: 'vault-1',
      credentialId: 'credential-1',
      credentialIds: ['credential-1', 'credential-2', 'credential-3'],
    });
    expect(created.map((entry) => entry.url)).toEqual(urls.slice(0, 3));
    expect(new Set(created.map((entry) => entry.token)).size).toBe(1);
    for (const entry of created) {
      expect(verifyTenantToken(entry.token, OPTS.signingSecret)).toMatchObject({
        tenantId: TENANT,
        role: 'owner',
      });
    }

    const second = await ensureTenantVault(client, {
      ...OPTS,
      mcpServerUrls: urls,
      role: 'staff',
    });
    expect(second.credentialIds).toEqual(first.credentialIds);
    expect(created).toHaveLength(3);
    expect(updated.map((entry) => entry.id)).toEqual(first.credentialIds);
    for (const entry of updated) {
      expect(verifyTenantToken(entry.token, OPTS.signingSecret)).toMatchObject({
        tenantId: TENANT,
        role: 'staff',
      });
    }
  });
});
