/**
 * Drain the transactional WhatsApp outbox (see @hisab/db outbox.ts). Rows are
 * claimed with FOR UPDATE SKIP LOCKED so two orchestrator processes never send the
 * same row; a send failure is retried on the next tick, up to MAX_ATTEMPTS, then
 * parked as `failed` with the error (visible in the admin panel, never silent).
 */
import { asc, eq } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';

export const MAX_ATTEMPTS = 5;

export type OutboxSender = (
  to: string,
  template: string,
  params: string[],
  buttonParam?: string,
) => Promise<void>;

export interface DrainResult {
  sent: number;
  retried: number;
  failed: number;
}

export async function drainOutbox(db: Db, send: OutboxSender, batch = 20): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, retried: 0, failed: 0 };
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.outboundNotifications)
      .where(eq(schema.outboundNotifications.status, 'pending'))
      .orderBy(asc(schema.outboundNotifications.createdAt))
      .limit(batch)
      .for('update', { skipLocked: true });
    for (const row of rows) {
      try {
        await send(row.toE164, row.template, row.bodyParams, row.buttonParam ?? undefined);
        await tx
          .update(schema.outboundNotifications)
          .set({ status: 'sent', sentAt: new Date(), attempts: row.attempts + 1, lastError: null })
          .where(eq(schema.outboundNotifications.id, row.id));
        result.sent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        await tx
          .update(schema.outboundNotifications)
          .set({ attempts, status: failed ? 'failed' : 'pending', lastError: String(err).slice(0, 500) })
          .where(eq(schema.outboundNotifications.id, row.id));
        if (failed) result.failed += 1;
        else result.retried += 1;
      }
    }
  });
  return result;
}

/** Run the drain every `intervalMs`; errors are reported, never thrown away. */
export function startOutboxDrain(
  db: Db,
  send: OutboxSender,
  log: (msg: string, fields?: Record<string, unknown>) => void,
  intervalMs = 15_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    drainOutbox(db, send)
      .then((r) => {
        if (r.sent || r.retried || r.failed) log('outbox drained', { ...r });
      })
      .catch((err) => log('outbox drain failed', { error: String(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
