/**
 * Per-tenant Managed Agents vault holding the Ledger MCP bearer credential.
 *
 * The bearer IS the HMAC-signed tenant token (mcp-ledger verifies it and derives
 * tenant_id from it — never from tool arguments). One session = one tenant = one
 * vault. Secrets live only in vaults, never in the agent definition or prompts.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { createTenantToken } from '@hisab/mcp-ledger';
import type { Role } from '@hisab/shared';

export interface TenantVaultOptions {
  tenantId: string;
  ledgerMcpUrl: string;
  /** TENANT_SIGNING_SECRET shared with the Ledger MCP server. */
  signingSecret: string;
  /** Token lifetime; default 24h (a WhatsApp conversation day). */
  ttlSeconds?: number;
  /**
   * The acting caller's role for this session (PRD v2.0 §3). The MCP servers gate
   * every tool by this role, so the bearer is rotated per turn to carry the
   * resolved role. Defaults to owner for back-compat (pre-P8 single-user tenants).
   */
  role?: Role;
  /** The acting user's id, for audit attribution; optional. */
  userId?: string;
}

export const tenantVaultName = (tenantId: string): string => `hisab-tenant-${tenantId}`;

/** Mint the signed, role-scoped bearer the vault injects as `Authorization: Bearer …`. */
export function mintLedgerBearer(opts: TenantVaultOptions): string {
  return createTenantToken(opts.tenantId, opts.signingSecret, {
    ttlSeconds: opts.ttlSeconds ?? 86_400,
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
  });
}

/**
 * Idempotent: find-or-create the tenant's vault, then rotate-or-create the
 * static_bearer credential for the Ledger MCP URL with a freshly minted token.
 * Call before each session so the session never starts with an expired bearer.
 */
export async function ensureTenantVault(
  client: Anthropic,
  opts: TenantVaultOptions,
): Promise<{ vaultId: string; credentialId: string }> {
  const name = tenantVaultName(opts.tenantId);

  let vaultId: string | undefined;
  for await (const vault of client.beta.vaults.list()) {
    if (vault.display_name === name) {
      vaultId = vault.id;
      break;
    }
  }
  if (!vaultId) {
    const vault = await client.beta.vaults.create({
      display_name: name,
      metadata: { tenant_id: opts.tenantId, project: 'hisabkitab' },
    });
    vaultId = vault.id;
  }

  const token = mintLedgerBearer(opts);

  for await (const cred of client.beta.vaults.credentials.list(vaultId)) {
    if (cred.auth.type === 'static_bearer' && cred.auth.mcp_server_url === opts.ledgerMcpUrl) {
      await client.beta.vaults.credentials.update(cred.id, {
        vault_id: vaultId,
        auth: { type: 'static_bearer', token },
      });
      return { vaultId, credentialId: cred.id };
    }
  }

  const created = await client.beta.vaults.credentials.create(vaultId, {
    display_name: `ledger bearer (${opts.tenantId})`,
    auth: { type: 'static_bearer', mcp_server_url: opts.ledgerMcpUrl, token },
  });
  return { vaultId, credentialId: created.id };
}
