/**
 * Transactional WhatsApp outbox (migration 0019). Call `enqueueNotification` INSIDE
 * the transaction that commits the business event (e.g. a settled Khalti payment):
 * the notification exists iff the event committed, and `dedupe_key` makes a
 * replayed event (double callback, verify after callback) queue it only once.
 * The orchestrator drains the table and sends the approved template.
 */
import * as schema from './schema.js';
import type { Db, Tx } from './client.js';

export interface OutboundNotification {
  tenantId?: string | null;
  toE164: string;
  template: string;
  bodyParams: string[];
  buttonParam?: string | null;
  /** e.g. `payment_received:<pidx>` — one notification per business event. */
  dedupeKey: string;
}

/** Queue a notification; returns false when this dedupe key was already queued. */
export async function enqueueNotification(tx: Db | Tx, n: OutboundNotification): Promise<boolean> {
  const rows = await tx
    .insert(schema.outboundNotifications)
    .values({
      tenantId: n.tenantId ?? null,
      toE164: n.toE164,
      template: n.template,
      bodyParams: n.bodyParams,
      buttonParam: n.buttonParam ?? null,
      dedupeKey: n.dedupeKey,
    })
    .onConflictDoNothing({ target: schema.outboundNotifications.dedupeKey })
    .returning({ id: schema.outboundNotifications.id });
  return rows.length > 0;
}
