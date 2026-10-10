/**
 * Server-side confirm-before-save. A draft may only be confirmed after the owner
 * said an explicit "yes" (owner_approvals row written by the orchestrator from the
 * verified WhatsApp text) NEWER than the draft and at most
 * OWNER_APPROVAL_WINDOW_MINUTES old. The model can neither write nor fake it.
 *
 * Both timestamps come from the DB clock (draft created_at default now(), approval
 * approved_at default now()), so there is one clock.
 */
import { sql } from 'drizzle-orm';
import { OWNER_APPROVAL_WINDOW_MINUTES } from '@hisab/shared';
import type { Tx } from '@hisab/db';

export const NO_OWNER_APPROVAL = {
  ok: false as const,
  needs_owner_approval: true as const,
  reason:
    'not confirmed: no explicit "yes" from the owner after this draft was shown. ' +
    'Show the owner the drafted figures and ask them to reply YES / हो to save it, then call confirm again.',
};

/** The refusal, echoing the draft's own figures so the agent can re-show them (Audit Gate evidence). */
export const noOwnerApproval = (draft: Record<string, unknown> = {}) => ({ ...NO_OWNER_APPROVAL, draft });

export async function ownerApprovedAfter(
  tx: Tx,
  tenantId: string,
  draftCreatedAt: Date,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 FROM owner_approvals
     WHERE tenant_id = ${tenantId}
       AND approved_at > ${draftCreatedAt.toISOString()}::timestamptz
       AND approved_at > now() - make_interval(mins => ${OWNER_APPROVAL_WINDOW_MINUTES})
     LIMIT 1`)) as unknown as unknown[];
  return [...rows].length > 0;
}
