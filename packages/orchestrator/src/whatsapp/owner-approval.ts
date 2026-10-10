/**
 * Server-side confirm-before-save, orchestrator half. When a VERIFIED inbound
 * message (webhook signature + sender→membership) is an explicit "yes" from a
 * member whose role may confirm, record it in owner_approvals. The ledger's
 * confirm tools only flip a draft that is older than such a record (and the
 * record is fresh), so the model alone can never "confirm" anything.
 *
 * Idempotent per (tenant, wa_message_id): a redelivered webhook adds nothing.
 */
import { appendAudit, schema, type Db } from '@hisab/db';
import { can, classifyOwnerApproval, type Role } from '@hisab/shared';

export async function recordOwnerApproval(
  db: Db,
  m: {
    tenantId: string;
    waMessageId: string;
    userId?: string;
    role: Role;
    text: string | undefined;
  },
): Promise<boolean> {
  if (!m.text || !can(m.role, 'confirm_entry')) return false;
  const verdict = classifyOwnerApproval(m.text);
  if (!verdict.approved) return false;
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.ownerApprovals)
      .values({
        tenantId: m.tenantId,
        waMessageId: m.waMessageId,
        ...(m.userId ? { userId: m.userId } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: schema.ownerApprovals.id });
    if (inserted.length === 0) return false;
    await appendAudit(tx, m.tenantId, {
      actor: 'owner',
      action: 'owner_approval',
      detail: { wa_message_id: m.waMessageId, matched: verdict.matched, role: m.role },
    });
    return true;
  });
}
