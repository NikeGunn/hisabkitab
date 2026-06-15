/**
 * Vault bearer minting: the token the vault injects must round-trip through the
 * Ledger MCP's verifier. PROBE: wrong secret / wrong tenant must be rejected.
 */
import { describe, expect, it } from 'vitest';
import { verifyTenantToken, AuthError } from '@hisab/mcp-ledger';
import { mintLedgerBearer, tenantVaultName } from '../src/vault/tenant-vault.js';

const TENANT = '7b39c2a4-1f7e-4d2a-9c1b-2f6e8a0d4c11';
const OPTS = {
  tenantId: TENANT,
  ledgerMcpUrl: 'https://ledger.example/mcp',
  signingSecret: 'test-secret',
};

describe('mintLedgerBearer', () => {
  it('round-trips through the MCP verifier and scopes to the tenant (default owner)', () => {
    expect(verifyTenantToken(mintLedgerBearer(OPTS), 'test-secret')).toEqual({ tenantId: TENANT, role: 'owner' });
  });

  it('carries the acting role into the bearer (RBAC, PRD §3)', () => {
    const bearer = mintLedgerBearer({ ...OPTS, role: 'staff' });
    expect(verifyTenantToken(bearer, 'test-secret')).toMatchObject({ tenantId: TENANT, role: 'staff' });
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
});
