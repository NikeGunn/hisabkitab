/**
 * Inbound message router — the Phase 3 spine:
 *   dedupe (exactly-once) → sender→tenant → pairing for unknowns →
 *   media→Files → session turn (Audit Gate in runTurn) → reply via WhatsApp.
 *
 * A tenant's messages are SERIALIZED (one turn at a time per key); different
 * tenants run concurrently. Webhook handler ACKs Meta immediately and calls
 * this asynchronously.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { schema, type Db } from '@hisab/db';
import type { GateLogger } from '../audit/audit-logger.js';
import { runTurn } from '../session/client.js';
import { getOrCreateTenantSession, type SessionStoreDeps } from './../session/store.js';
import {
  findTenantBySender,
  handleUnknownSender,
  ONBOARDING_PROMPT,
  pairedWelcome,
} from '../onboarding/pairing.js';
import { attachInboundMedia } from './media.js';
import type { InboundMessage } from './inbound.js';
import type { WaClient } from './wa-client.js';

/** Per-key promise chains: serialize work per tenant/sender, parallel across keys. */
export class SerialQueues {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const next = tail.then(task, task);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

export interface RouterDeps extends SessionStoreDeps {
  anthropic: Anthropic;
  db: Db;
  wa: WaClient;
  gateLogger: GateLogger;
  queues: SerialQueues;
  log?: (msg: string) => void;
  /** Per-turn hard cap, ms; default 10 min (see runTurn). */
  turnTimeoutMs?: number;
}

export const UNSUPPORTED_REPLY =
  'I can read text, photos and PDF bills for now. 🙏 Voice notes are coming soon — ' +
  'meanwhile, could you type it or send a photo?';

export const MEDIA_FAILURE_REPLY =
  'Sorry — I could not download that file. Could you try sending it again?';

/** True when the message was processed; false when deduped as a retry. */
export async function processInbound(deps: RouterDeps, msg: InboundMessage): Promise<boolean> {
  // Exactly-once: Meta retries webhooks; the wa_events PK is the gate.
  const inserted = await deps.db
    .insert(schema.waEvents)
    .values({ waMessageId: msg.waMessageId, fromE164: msg.fromE164 })
    .onConflictDoNothing()
    .returning({ id: schema.waEvents.waMessageId });
  if (inserted.length === 0) {
    deps.log?.(`dedupe: ${msg.waMessageId} already processed`);
    return false;
  }

  return deps.queues.run(msg.fromE164, async () => {
    const tenant = await findTenantBySender(deps.db, msg.fromE164);

    if (!tenant) {
      const outcome = await handleUnknownSender(deps.db, msg.fromE164, msg.text);
      if (outcome.kind === 'paired') {
        await deps.wa.sendText(msg.fromE164, pairedWelcome(outcome.businessName));
      } else if (outcome.kind === 'invalid_code') {
        await deps.wa.sendText(
          msg.fromE164,
          'That code is not valid (or has expired). Please check it, or contact us for a new one.',
        );
      } else {
        await deps.wa.sendText(msg.fromE164, ONBOARDING_PROMPT);
      }
      return true;
    }

    if (msg.kind === 'audio' || msg.kind === 'unsupported') {
      await deps.wa.sendText(msg.fromE164, UNSUPPORTED_REPLY);
      return true;
    }

    const { sessionId } = await getOrCreateTenantSession(deps, tenant.tenantId);

    let turnText = msg.text ?? '';
    if (msg.media) {
      try {
        const mountPath = await attachInboundMedia(deps.anthropic, deps.wa, sessionId, msg.media);
        turnText =
          `The owner sent a ${msg.kind} (saved at ${mountPath}; files added mid-session ` +
          `can also appear under /mnt/session/uploads${mountPath} — check both). ` +
          `Follow the bill-extraction skill on it.` +
          (msg.text ? ` Their caption: "${msg.text}"` : '');
      } catch (err) {
        deps.log?.(`media failed for ${msg.waMessageId}: ${String(err)}`);
        await deps.wa.sendText(msg.fromE164, MEDIA_FAILURE_REPLY);
        return true;
      }
    }
    if (!turnText.trim()) {
      await deps.wa.sendText(msg.fromE164, UNSUPPORTED_REPLY);
      return true;
    }

    const turn = await runTurn(deps.anthropic, sessionId, turnText, {
      tenantId: tenant.tenantId,
      logger: deps.gateLogger,
      deliver: (text) => deps.wa.sendText(msg.fromE164, text),
      ...(deps.turnTimeoutMs !== undefined ? { timeoutMs: deps.turnTimeoutMs } : {}),
      ...(deps.log ? { onEvent: (type: string) => deps.log?.(`event ${type}`) } : {}),
    });
    if (turn.status === 'timeout') deps.log?.(`turn TIMED OUT for ${msg.waMessageId}`);
    return true;
  });
}
