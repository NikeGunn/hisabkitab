/**
 * Persistent tenant→session registry (tenant_sessions). Reuses the live session
 * across messages (Managed Agents keeps history + compaction server-side);
 * rotates the vault bearer before reuse so the ledger token is never stale, and
 * replaces sessions that terminated or vanished.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import type { Role } from '@hisab/shared';
import { ensureTenantVault, type TenantVaultOptions } from '../vault/tenant-vault.js';
import { startTenantSession } from './client.js';

export interface SessionStoreDeps {
  anthropic: Anthropic;
  db: Db;
  agentId: string;
  environmentId: string;
  ledgerMcpUrl: string;
  signingSecret: string;
}

/** Who is acting this turn — the bearer is rotated to carry this role (PRD §3). */
export interface ActingCaller {
  role: Role;
  userId?: string;
}

export async function getOrCreateTenantSession(
  deps: SessionStoreDeps,
  tenantId: string,
  caller: ActingCaller = { role: 'owner' },
): Promise<{ sessionId: string; vaultId: string }> {
  const vaultOpts: TenantVaultOptions = {
    tenantId,
    ledgerMcpUrl: deps.ledgerMcpUrl,
    signingSecret: deps.signingSecret,
    role: caller.role,
    ...(caller.userId !== undefined ? { userId: caller.userId } : {}),
  };

  const rows = await deps.db
    .select()
    .from(schema.tenantSessions)
    .where(eq(schema.tenantSessions.tenantId, tenantId))
    .limit(1);
  const existing = rows[0];

  if (existing) {
    try {
      const session = await deps.anthropic.beta.sessions.retrieve(existing.sessionId);
      if (session.status !== 'terminated' && session.archived_at === null) {
        await ensureTenantVault(deps.anthropic, vaultOpts); // rotate the bearer
        return { sessionId: existing.sessionId, vaultId: existing.vaultId };
      }
    } catch {
      /* session gone — fall through and create a fresh one */
    }
  }

  const { vaultId } = await ensureTenantVault(deps.anthropic, vaultOpts);
  const { sessionId } = await startTenantSession(deps.anthropic, {
    agentId: deps.agentId,
    environmentId: deps.environmentId,
    vaultId,
    tenantId,
  });

  await deps.db
    .insert(schema.tenantSessions)
    .values({ tenantId, sessionId, vaultId })
    .onConflictDoUpdate({
      target: schema.tenantSessions.tenantId,
      set: { sessionId, vaultId, updatedAt: new Date() },
    });

  return { sessionId, vaultId };
}
