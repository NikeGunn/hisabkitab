/**
 * Orchestrator session client (PRD v1.1 Phase 2).
 *
 * One session = one tenant. The Pre-delivery Audit Gate sits in the relay path:
 * every `agent.message` is audited against the turn's tool-result evidence
 * BEFORE delivery. Held messages are never relayed — the agent is instructed to
 * re-verify or ask the owner; after MAX_HOLDS_PER_TURN a figure-free fallback
 * is delivered instead. Every gate decision is logged.
 */
import type Anthropic from '@anthropic-ai/sdk';
import {
  addToolResultEvidence,
  auditOutbound,
  correctiveInstruction,
  HELD_FALLBACK_MESSAGE,
  newTurnEvidence,
} from '../audit/gate.js';
import type { GateLogger } from '../audit/audit-logger.js';

const MAX_HOLDS_PER_TURN = 2;

/**
 * Pull a `report_request` marker out of a request_report tool result. The result is
 * doubly-encoded (the MCP wraps JSON text in content blocks, then we stringify), so we
 * find the inner object robustly rather than fully parsing the envelope.
 */
function captureReportRequest(rawToolResult: string): CapturedReportRequest | null {
  if (!rawToolResult.includes('report_request')) return null;
  try {
    // The content array holds {type:'text', text:'<json>'}; recover that inner json.
    const blocks = JSON.parse(rawToolResult) as Array<{ text?: string }> | { text?: string };
    const texts = Array.isArray(blocks) ? blocks.map((b) => b.text ?? '') : [blocks.text ?? ''];
    for (const t of texts) {
      if (!t.includes('report_request')) continue;
      const parsed = JSON.parse(t) as { accepted?: boolean; report_request?: CapturedReportRequest };
      if (parsed.accepted && parsed.report_request) return parsed.report_request;
    }
  } catch {
    // tolerant: a malformed/partial result simply yields no report dispatch.
  }
  return null;
}

export interface StartSessionOptions {
  agentId: string;
  /** Pin a version for reproducibility; omit for latest. */
  agentVersion?: number;
  environmentId: string;
  vaultId: string;
  tenantId: string;
  title?: string;
}

export async function startTenantSession(
  client: Anthropic,
  opts: StartSessionOptions,
): Promise<{ sessionId: string }> {
  const session = await client.beta.sessions.create({
    agent:
      opts.agentVersion !== undefined
        ? { type: 'agent', id: opts.agentId, version: opts.agentVersion }
        : opts.agentId,
    environment_id: opts.environmentId,
    vault_ids: [opts.vaultId],
    title: opts.title ?? `hisab tenant ${opts.tenantId}`,
    metadata: { tenant_id: opts.tenantId, project: 'hisabkitab' },
  });
  return { sessionId: session.id };
}

export interface TurnOptions {
  tenantId: string;
  logger: GateLogger;
  /** Relay one gate-passed message to the owner (Phase 3 wires this to WhatsApp). */
  deliver: (text: string) => void | Promise<void>;
  /** Hard cap on stream wait, ms (long Opus turns are normal; default 10 min). */
  timeoutMs?: number;
  /** Observe raw stream event types (verification/diagnostics). */
  onEvent?: (type: string) => void;
  /** Observe each tool the agent invoked this turn, by name (cost/quality probes). */
  onToolUse?: (name: string) => void;
}

/** A report the agent asked to generate this turn (from the request_report tool result). */
export interface CapturedReportRequest {
  report_type: 'receivables' | 'payables' | 'statement' | 'sales_summary';
  party?: string;
  as_of?: string;
  bs_year?: number;
  bs_month?: number;
}

export interface TurnResult {
  delivered: string[];
  holds: number;
  status: 'idle' | 'terminated' | 'timeout';
  errors: string[];
  /** report jobs the agent requested this turn (dispatched by the router after the turn). */
  reportRequests: CapturedReportRequest[];
  /** names of every tool the agent invoked this turn, in order (cost/quality probes). */
  toolUses: string[];
}

/**
 * Send one owner message and drain the stream until a terminal idle.
 * Stream-first ordering; idle with `requires_action` is not terminal; an idle
 * that lands while a corrective retry is pending is also not terminal.
 */
export async function runTurn(
  client: Anthropic,
  sessionId: string,
  userText: string,
  opts: TurnOptions,
): Promise<TurnResult> {
  const result: TurnResult = { delivered: [], holds: 0, status: 'idle', errors: [], reportRequests: [], toolUses: [] };
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);

  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: userText }] }],
  });

  let evidence = newTurnEvidence();
  let awaitingRetry = false;

  // The deadline must fire even when the stream goes SILENT (hung MCP call,
  // dropped SSE) — so race every iterator step against the remaining time
  // instead of only checking when an event happens to arrive.
  const iterator = stream[Symbol.asyncIterator]();
  const TIMED_OUT = Symbol('timeout');
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.status = 'timeout';
      break;
    }
    let timer: NodeJS.Timeout | undefined;
    const step = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (step === TIMED_OUT) {
      result.status = 'timeout';
      // unblock the session — a turn left running/awaiting would 400 every
      // subsequent user.message ("waiting on responses to events …")
      await client.beta.sessions.events
        .send(sessionId, { events: [{ type: 'user.interrupt' }] })
        .catch(() => undefined);
      (stream as { controller?: AbortController }).controller?.abort();
      break;
    }
    if (step.done) break;
    const event = step.value;
    opts.onEvent?.(event.type);
    switch (event.type) {
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': {
        const toolName = (event as { name?: string }).name;
        if (toolName) {
          result.toolUses.push(toolName);
          opts.onToolUse?.(toolName);
        }
        // Safety net: all tools on this agent are first-party (ledger MCP is
        // tenant-scoped; owner consent is modeled as draft→confirm_entry).
        // If a call still arrives permission-gated, allow it — otherwise the
        // session stalls forever waiting for a confirmation nobody sends.
        const gated = (event as { evaluated_permission?: string }).evaluated_permission === 'ask';
        if (gated) {
          await client.beta.sessions.events.send(sessionId, {
            events: [
              { type: 'user.tool_confirmation', tool_use_id: event.id, result: 'allow' },
            ] as never,
          });
        }
        break;
      }

      case 'agent.tool_result':
      case 'agent.mcp_tool_result': {
        const raw = JSON.stringify(event.content ?? '');
        addToolResultEvidence(evidence, raw, { isError: event.is_error ?? false });
        const captured = captureReportRequest(raw);
        if (captured) result.reportRequests.push(captured);
        break;
      }

      case 'agent.message': {
        const text = event.content.map((b) => b.text).join('\n');
        const decision = auditOutbound(text, evidence);
        await opts.logger.log({
          tenantId: opts.tenantId,
          sessionId,
          decision,
          messagePreview: text,
        });
        if (decision.action === 'deliver') {
          result.delivered.push(text);
          await opts.deliver(text);
        } else {
          result.holds += 1;
          if (result.holds <= MAX_HOLDS_PER_TURN) {
            awaitingRetry = true;
            evidence = newTurnEvidence(); // the retry must re-derive its evidence
            await client.beta.sessions.events.send(sessionId, {
              events: [
                {
                  type: 'user.message',
                  content: [{ type: 'text', text: correctiveInstruction(decision) }],
                },
              ],
            });
          } else {
            result.delivered.push(HELD_FALLBACK_MESSAGE);
            await opts.deliver(HELD_FALLBACK_MESSAGE);
          }
        }
        break;
      }

      case 'session.error':
        result.errors.push(JSON.stringify(event));
        break;

      case 'session.status_terminated':
        result.status = 'terminated';
        return result;

      case 'session.status_idle':
        if (event.stop_reason.type === 'requires_action') break;
        if (awaitingRetry) {
          // idle for the held turn; the queued corrective message is next
          awaitingRetry = false;
          break;
        }
        return result;

      default:
        break;
    }
  }
  return result;
}
