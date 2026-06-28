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
import { handleUnknownSender, ONBOARDING_PROMPT, pairedWelcome } from '../onboarding/pairing.js';
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
import { checkBudget, recordTurnUsage, latchWarn } from '../resilience/cost-guard.js';
import { routeTurn, BUDGET_THROTTLED_REPLY, BUDGET_WARN_NOTE } from '@hisab/shared';
import type { InboundMessage } from './inbound.js';
import type { WaClient } from './wa-client.js';
import { inboundCtx, type ObsCtx } from '../obs.js';

/**
 * Cost-control wiring (P11). `db` is the cross-tenant orch handle used to read the
 * tenant's plan + usage and record the turn's token cost. `model` is the active
 * agent model (HISAB_MODEL) used to price the turn. Omitted = no budgeting (e.g.
 * unit tests that don't exercise cost).
 */
export interface CostGuardDeps {
  db: Db;
  model: string;
}

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
  /** Per-tenant monthly budget + token accounting (P11). Omitted = no budgeting. */
  costGuard?: CostGuardDeps;
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
function inviteReply(
  res: ReturnType<typeof inviteMember> extends Promise<infer R> ? R : never,
): string {
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
      return 'I couldn\'t read that phone number. Try the full number, e.g. "add 9779812345678 as staff".';
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

/**
 * True when the message was processed; false when deduped as a retry.
 *
 * `obs` carries the correlation id (the inbound wa_message_id) so every line this
 * message produces — here, in runTurn, and in the downstream MCP call — is greppable
 * end to end (P14 §8). Omitted ⇒ derived from the message id (tests/back-compat).
 */
export async function processInbound(
  deps: RouterDeps,
  msg: InboundMessage,
  obs: ObsCtx = inboundCtx(msg.waMessageId),
): Promise<boolean> {
  obs.metrics.inbound({ kind: msg.kind });
  // Exactly-once: Meta retries webhooks; the wa_events PK is the gate.
  const inserted = await deps.db
    .insert(schema.waEvents)
    .values({ waMessageId: msg.waMessageId, fromE164: msg.fromE164 })
    .onConflictDoNothing()
    .returning({ id: schema.waEvents.waMessageId });
  if (inserted.length === 0) {
    obs.log.debug('dedupe: message already processed');
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
    // From here the correlation id also carries the tenant — every downstream line
    // is tagged {correlation_id, tenant_id} without re-passing them.
    const tlog = obs.log.child({ tenant_id: tenant.tenantId, role: member.role });

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
      deps.log?.(
        `credential blocked for ${msg.fromE164} [${cred.kinds.join(',')}]: ${cred.redactedPreview}`,
      );
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

    // Model routing (P11 §7): a trivial turn ("ok"/"thanks"/👍) is answered LOCALLY
    // with a canned reply — no agent session, no model call (the biggest cost saver).
    // Media always forces a real turn (a bill must reach the agent). The turn still
    // counts toward `turns` (≈0 cost) so the spend dashboard sees the traffic.
    const route = routeTurn(msg.text, Boolean(msg.media));
    if (route.intent === 'trivial' && route.cannedReply) {
      await deps.wa.sendText(msg.fromE164, route.cannedReply);
      if (deps.costGuard) {
        await recordTurnUsage(deps.costGuard.db, tenant.tenantId, '', {
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      return true;
    }

    // Budget gate (P11 §7): if the tenant has burned this month's model budget, stop
    // starting agent turns (backpressure, never data loss) — tell them it resets /
    // to upgrade. A WARN is served but flagged so we append a one-time nudge below.
    let warnNote = false;
    if (deps.costGuard) {
      const budget = await checkBudget(deps.costGuard.db, tenant.tenantId);
      if (budget.verdict === 'THROTTLE') {
        deps.log?.(
          `budget THROTTLE ${tenant.tenantId} (${budget.spentPaisa}/${budget.capPaisa} paisa)`,
        );
        await deps.wa.sendText(msg.fromE164, BUDGET_THROTTLED_REPLY);
        return true;
      }
      if (budget.verdict === 'WARN') {
        // nudge the owner at most once per period (latch wins the race)
        warnNote = await latchWarn(deps.costGuard.db, tenant.tenantId);
      }
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

    const turnStart = Date.now();
    const turn = await runTurn(deps.anthropic, sessionId, turnText, {
      tenantId: tenant.tenantId,
      logger: deps.gateLogger,
      deliver: (text) => deps.wa.sendText(msg.fromE164, text),
      correlationId: obs.correlationId,
      metrics: obs.metrics,
      ...(deps.turnTimeoutMs !== undefined ? { timeoutMs: deps.turnTimeoutMs } : {}),
      ...(deps.log ? { onEvent: (type: string) => deps.log?.(`event ${type}`) } : {}),
    });
    // Turn-level metrics (P14 §8): latency distribution + outcome counter.
    obs.metrics.turnLatency(Date.now() - turnStart, { status: turn.status });
    obs.metrics.turn({ status: turn.status === 'idle' ? 'delivered' : turn.status });
    if (turn.holds > 0) obs.metrics.error({ component: 'audit-gate-hold' });
    tlog.info('turn complete', {
      status: turn.status,
      delivered: turn.delivered.length,
      holds: turn.holds,
      tools: turn.toolUses.length,
      latency_ms: Date.now() - turnStart,
    });
    if (turn.status === 'timeout') deps.log?.(`turn TIMED OUT for ${msg.waMessageId}`);

    // P11: record this turn's token cost (atomic upsert) and, if we just crossed the
    // soft-warn line, nudge the owner exactly once this period. Accounting failures
    // must never break the chat — log and move on.
    if (deps.costGuard) {
      try {
        await recordTurnUsage(deps.costGuard.db, tenant.tenantId, deps.costGuard.model, {
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
        });
      } catch (err) {
        deps.log?.(`usage record failed for ${tenant.tenantId}: ${String(err)}`);
      }
      if (warnNote) {
        await deps.wa.sendText(msg.fromE164, BUDGET_WARN_NOTE.trim());
      }
    }

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
