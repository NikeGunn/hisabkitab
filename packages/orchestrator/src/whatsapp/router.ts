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
import { appendAudit, schema, type Db } from '@hisab/db';
import type { GateLogger } from '../audit/audit-logger.js';
import { runTurn, type CapturedReportRequest } from '../session/client.js';
import { getOrCreateTenantSession, type SessionStoreDeps } from './../session/store.js';
import {
  handleUnknownSender,
  ONBOARDING_PROMPT,
  pairedWelcome,
} from '../onboarding/pairing.js';
import {
  resolveMembership,
  parseInviteCommand,
  isAcceptCommand,
  inviteMember,
  acceptInvite,
} from '../identity/membership.js';
import { attachInboundMedia } from './media.js';
import { scanForCredentials, CREDENTIAL_REFUSAL } from '../security/credential-guard.js';
import { TenantRateLimiter, RATE_LIMITED_REPLY } from '../resilience/rate-limit.js';
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
  /** Per-tenant inbound rate limiter (cost guard). Omitted = no limiting. */
  rateLimiter?: TenantRateLimiter;
  /**
   * Dispatch a PDF report the agent asked for this turn (Module C). Runs AFTER the turn
   * so the agent's "preparing your PDF…" acknowledgement is delivered first, then the
   * document arrives on the open 24h window. Omitted = reports disabled.
   */
  dispatchReport?: (tenantId: string, toE164: string, req: CapturedReportRequest) => Promise<void>;
}

export const UNSUPPORTED_REPLY =
  'I can read text, photos and PDF bills for now. 🙏 Voice notes are coming soon — ' +
  'meanwhile, could you type it or send a photo?';

export const MEDIA_FAILURE_REPLY =
  'Sorry — I could not download that file. Could you try sending it again?';

/** Reply to an owner's invite command (PRD v2.0 §3). */
function inviteReply(res: ReturnType<typeof inviteMember> extends Promise<infer R> ? R : never): string {
  switch (res.kind) {
    case 'invited':
      return (
        `Invite sent to ${res.inviteE164} as ${res.role}. 🙌 Ask them to message me ` +
        `"JOIN" from that number to accept. They'll get ${res.role} access only.`
      );
    case 'already_member':
      return `That number is already on your team (as ${res.role}). Nothing to do.`;
    case 'not_owner':
      return 'Only the business owner can add team members. Please ask the owner to do this.';
    case 'bad_role':
      return 'You can add someone as accountant, staff, or viewer. For example: "add 98XXXXXXXX as accountant".';
    case 'bad_number':
      return "I couldn't read that phone number. Try the full number, e.g. \"add 9779812345678 as staff\".";
  }
}

/** Welcome a newly joined member, stating their (limited) access. */
function memberWelcome(businessName: string, role: string): string {
  const access: Record<string, string> = {
    accountant: 'record and confirm entries, prepare VAT, and pull reports',
    staff: 'record draft entries (the owner or accountant confirms them)',
    viewer: 'view reports and summaries',
  };
  return (
    `You've joined ${businessName} as ${role}. 🎉 You can ${access[role] ?? 'use HisabKitab'}. ` +
    `Money actions and team changes stay with the owner.`
  );
}

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
    const member = await resolveMembership(deps.db, msg.fromE164);

    if (!member) {
      // An invited number accepting its seat is the first thing we check — only
      // THIS verified sender can accept its own invite (no self-escalation).
      if (isAcceptCommand(msg.text)) {
        const accepted = await acceptInvite(deps.db, msg.fromE164);
        if (accepted.kind === 'accepted') {
          await deps.wa.sendText(msg.fromE164, memberWelcome(accepted.businessName, accepted.role));
          return true;
        }
      }
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

    const tenant = { tenantId: member.tenantId, businessName: member.businessName };

    // Owner-only invite command, handled BEFORE the agent turn so the model never
    // sees it as a normal request and a non-owner can never grant a seat. Authority
    // comes from `member.role` (the verified session), not the message text.
    const invite = parseInviteCommand(msg.text);
    if (invite) {
      const res = await inviteMember(deps.db, member, invite.e164, invite.role);
      await deps.wa.sendText(msg.fromE164, inviteReply(res));
      return true;
    }

    // Rate-limit (cost guard, PRD §7): a flood from one number must not run
    // unbounded agent turns. Over-limit → friendly nudge, no session started.
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.take(tenant.tenantId);
      if (!decision.allowed) {
        deps.log?.(`rate-limited ${msg.fromE164} (retry in ${decision.retryAfterMs}ms)`);
        await deps.wa.sendText(msg.fromE164, RATE_LIMITED_REPLY);
        return true;
      }
    }

    if (msg.kind === 'audio' || msg.kind === 'unsupported') {
      await deps.wa.sendText(msg.fromE164, UNSUPPORTED_REPLY);
      return true;
    }

    // Credential-scrub (PRD §14): refuse passwords/OTPs/logins BEFORE the message
    // reaches the agent session or any audit row. We never relay or persist the
    // secret — only a redacted preview is logged for ops.
    const cred = scanForCredentials(msg.text);
    if (cred.blocked) {
      deps.log?.(`credential blocked for ${msg.fromE164} [${cred.kinds.join(',')}]: ${cred.redactedPreview}`);
      await deps.db.transaction((tx) =>
        appendAudit(tx, tenant.tenantId, {
          actor: 'system',
          action: 'credential_blocked',
          detail: { kinds: cred.kinds, preview: cred.redactedPreview },
        }),
      );
      await deps.wa.sendText(msg.fromE164, CREDENTIAL_REFUSAL);
      return true;
    }

    const { sessionId } = await getOrCreateTenantSession(deps, tenant.tenantId, {
      role: member.role,
      userId: member.userId,
    });

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

    // After the turn (so the "preparing…" ack lands first), render+deliver any reports
    // the agent requested. A report failure never breaks the chat — it self-holds + asks.
    if (deps.dispatchReport && turn.reportRequests.length > 0) {
      for (const req of turn.reportRequests) {
        try {
          await deps.dispatchReport(tenant.tenantId, msg.fromE164, req);
        } catch (err) {
          deps.log?.(`report dispatch failed for ${msg.fromE164}: ${String(err)}`);
        }
      }
    }
    return true;
  });
}
