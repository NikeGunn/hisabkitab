/**
 * RehearsalEnv — one bookkeeping conversation as a seeded, replayable episode.
 *
 *   reset({seed, scenario_id}) → [observation, info]
 *   step(action)               → [observation, reward, terminated, truncated, info]
 *   snapshot() / restore(s)    → pure JSON state (crash recovery, replay)
 *
 * Gymnasium-style contract, but the world is HisabKitab's: a simulated owner on
 * WhatsApp, the sandbox ledger (real schemas + VAT + Validation Engine), and every
 * agent message passing the REAL pre-delivery Audit Gate before the owner sees it.
 *
 * Determinism: no clock, no Math.random, no network. Same scenario + same actions
 * ⇒ same events, same state digest, same reward (tested).
 */
import { addOwnerFigures, addToolResultEvidence, auditOutbound, newTurnEvidence } from '@hisab/orchestrator';
import { isOwnerApproval } from '@hisab/shared';
import {
  ActionSchema,
  TOOL_NAMES,
  type Action,
  type EventKind,
  type LabEvent,
  type Observation,
  type StepResult,
  type ToolName,
  type ToolResult,
} from '../contracts.js';
import { digest } from '../hash.js';
import { getScenario } from '../scenarios/catalog.js';
import type { OwnerLine, Scenario } from '../scenarios/types.js';
import { judge, type Verdict } from '../judge/judge.js';
import { runTool, type LedgerState } from './tools.js';
import { asksOwner } from './asks-owner.js';

/**
 * env-2: the simulated owner answers "is this for your business?" (production's
 *        record_expense REQUIRES for_taxable_business_use, so a careful agent asks).
 * env-3: the owner recognises a confirmation request in Nepali / Romanized Nepali,
 *        not only a "?" (asks-owner.ts).
 * env-4: production parity with the 2026-10-10 fixes — server-side confirm guard (a draft
 *        is confirmable only after an explicit owner yes NEWER than it), owner figures stay
 *        gate evidence for the whole conversation, corrections supersede their draft,
 *        validate_entry echoes figures. The owner re-affirms once when asked to confirm
 *        what they already approved, and answers a clarification with the scenario's fact.
 * Both gaps were found by running the REAL agent; results are only comparable within a version.
 */
export const ENV_VERSION = 'rehearsal-env-4';

export interface EnvOptions {
  /** Production's server-side confirm guard. Default ON (prod parity); OFF only for judge probes. */
  guards?: boolean;
}
export const MAX_STEPS = 24;
/** How many times the owner will nudge "please go ahead" when asked something they have no scripted answer for. */
const OWNER_NUDGES = 2;

export interface EnvState {
  env_version: string;
  scenario_id: string;
  step: number;
  done: boolean;
  truncated: boolean;
  ledger: LedgerState;
  tool_calls: Partial<Record<ToolName, number>>;
  owner_cursor: number;
  owner_nudges: number;
  owner_waiting: boolean;
  pending_owner: string | null;
  attached: string[];
  approvals: string[];
  /** Steps at which the owner's text was an explicit yes (isOwnerApproval) — the server-side guard's input. */
  owner_yes_steps: number[];
  /** Every owner message so far: their figures stay gate evidence for the conversation (prod parity). */
  owner_texts: string[];
  guards: boolean;
  owner_reaffirmed: boolean;
  clarify_answered: boolean;
  last_owner_intent: string | null;
  last_correction_step: number;
  evidence: { numbers: string[]; failures: string[]; errors: string[] };
  last_tool_result: ToolResult | null;
  last_message: { delivered: boolean; gate_reasons: string[] } | null;
  events: LabEvent[];
  verdict: Verdict | null;
}

export class RehearsalEnv {
  private s!: EnvState;
  private scenario!: Scenario;

  constructor(private readonly opts: EnvOptions = {}) {}

  get state(): Readonly<EnvState> {
    return this.s;
  }

  get currentScenario(): Scenario {
    return this.scenario;
  }

  reset(opts: { scenario_id: string; seed?: number }): [Observation, { events: LabEvent[]; scenario_id: string }] {
    this.scenario = getScenario(opts.scenario_id);
    if (opts.seed !== undefined && opts.seed !== this.scenario.seed) {
      throw new Error(`seed ${opts.seed} does not match scenario ${opts.scenario_id} (seed ${this.scenario.seed})`);
    }
    this.s = {
      env_version: ENV_VERSION,
      scenario_id: this.scenario.id,
      step: 0,
      done: false,
      truncated: false,
      ledger: {
        entries: this.scenario.existing.map((e, i) => ({
          id: `pre-${i}`,
          type: e.type,
          status: 'confirmed',
          taxable_paisa: e.taxable_paisa,
          vat_paisa: e.vat_paisa,
          total_paisa: e.total_paisa,
          occurred_on: e.occurred_on,
          vendor_name: e.vendor_name,
          invoice_no: e.invoice_no,
          preexisting: true,
          created_step: 0,
        })),
        next_id: 1,
        idem: {},
      },
      tool_calls: {},
      owner_cursor: 0,
      owner_nudges: 0,
      owner_waiting: false,
      pending_owner: null,
      attached: [],
      approvals: [],
      owner_yes_steps: [],
      owner_texts: [],
      guards: this.opts.guards ?? true,
      owner_reaffirmed: false,
      clarify_answered: false,
      last_owner_intent: null,
      last_correction_step: -1,
      evidence: { numbers: [], failures: [], errors: [] },
      last_tool_result: null,
      last_message: null,
      events: [],
      verdict: null,
    };
    const from = this.s.events.length;
    this.emit('episode_reset', {
      scenario_id: this.scenario.id,
      family: this.scenario.family,
      split: this.scenario.split,
      seed: this.scenario.seed,
      dataset_version: this.scenario.dataset_version,
      env_version: ENV_VERSION,
    });
    this.ownerSays(this.scenario.owner_script[0] as OwnerLine);
    this.s.owner_cursor = 1;
    return [this.observe(), { events: this.s.events.slice(from), scenario_id: this.scenario.id }];
  }

  step(rawAction: unknown): StepResult {
    if (this.s.done) throw new Error('episode finished — call reset()');
    const from = this.s.events.length;
    this.s.step += 1;
    this.s.last_tool_result = null;

    const parsed = ActionSchema.safeParse(rawAction);
    if (!parsed.success) {
      // Unknown/invalid action: typed error, NO side effect.
      this.emit('invalid_action', { issues: parsed.error.issues.map((i) => i.message).slice(0, 5) });
      return this.finishStep(from, 'invalid action');
    }
    const action: Action = parsed.data;
    this.emit('agent_decision', { action: summarizeAction(action) });

    if (action.type === 'tool') this.doTool(action.name, action.args);
    else if (action.type === 'message') this.doMessage(action.text);
    else this.s.done = true;

    if (!this.s.done && this.s.step >= MAX_STEPS) {
      this.s.done = true;
      this.s.truncated = true;
    }
    return this.finishStep(from);
  }

  snapshot(): { state: EnvState; digest: string } {
    const state = structuredClone(this.s);
    return { state, digest: digest(state) };
  }

  restore(snap: { state: EnvState; digest: string }): void {
    if (digest(snap.state) !== snap.digest) throw new Error('snapshot digest mismatch — refusing to restore a corrupted checkpoint');
    if (snap.state.env_version !== ENV_VERSION) throw new Error(`snapshot from ${snap.state.env_version}, env is ${ENV_VERSION}`);
    this.scenario = getScenario(snap.state.scenario_id);
    this.s = structuredClone(snap.state);
  }

  observe(): Observation {
    return {
      episode_id: `${this.scenario.id}#${this.scenario.seed}`,
      step: this.s.step,
      owner_message: this.s.pending_owner,
      bills: [...this.s.attached],
      tool_result: this.s.last_tool_result,
      last_message: this.s.last_message,
      owner_waiting: this.s.owner_waiting,
      tools: TOOL_NAMES,
    };
  }

  // ------------------------------------------------------------------ internals

  private finishStep(from: number, error?: string): StepResult {
    let reward = 0;
    if (this.s.done && !this.s.verdict) {
      this.s.verdict = judge(this.scenario, this.s.events, this.s.ledger.entries);
      reward = this.s.verdict.reward;
      this.emit('episode_end', {
        truncated: this.s.truncated,
        reward,
        passed: this.s.verdict.passed,
        failure_class: this.s.verdict.failure_class,
      });
    }
    return [
      this.observe(),
      reward,
      this.s.done && !this.s.truncated,
      this.s.truncated,
      { events: this.s.events.slice(from), ...(error ? { error } : {}) },
    ];
  }

  private emit(kind: EventKind, data: Record<string, unknown>): void {
    this.s.events.push({ seq: this.s.events.length, kind, data });
  }

  private doTool(name: ToolName, args: Record<string, unknown>): void {
    const n = (this.s.tool_calls[name] ?? 0) + 1;
    this.s.tool_calls[name] = n;
    this.emit('tool_call', { name, args, call_no: n });

    // Cross-tenant guard: like RLS, data from another business is never returned —
    // but the ATTEMPT is recorded so the judge can score it.
    const argText = JSON.stringify(args).toLowerCase();
    const marker = this.scenario.oracle.foreign_markers.find((m) => argText.includes(m.toLowerCase()));
    if (marker) {
      this.emit('cross_tenant_attempt', { tool: name });
      this.setToolResult({ name, ok: false, data: { error: 'access denied: one session = one business' } });
      return;
    }

    const fault = this.scenario.faults.find((f) => f.tool === name && f.on_call === n);
    if (fault?.kind === 'timeout') {
      this.emit('fault_injected', { tool: name, kind: fault.kind });
      this.setToolResult({ name, ok: false, data: { error: 'upstream timeout — the request may not have completed' } });
      return;
    }

    const out = runTool(name, args, {
      scenario: this.scenario,
      ledger: this.s.ledger,
      step: this.s.step,
      attached: this.s.attached,
      ...(this.s.guards ? { ownerYesSteps: this.s.owner_yes_steps } : {}),
    });
    if ('write' in out && out.write) {
      const e = out.write.entry;
      this.emit('ledger_write', {
        op: out.write.op,
        entry_id: e.id,
        entry_type: e.type,
        total_paisa: e.total_paisa,
        taxable_paisa: e.taxable_paisa,
        vat_paisa: e.vat_paisa,
        invoice_no: e.invoice_no,
        vendor_name: e.vendor_name,
        ...(out.write.op === 'confirm' ? { owner_approved: this.s.approvals.includes(e.id) } : {}),
      });
    }

    if (fault?.kind === 'ack_lost') {
      // The write HAPPENED, but the agent never hears back — the classic retry trap.
      this.emit('fault_injected', { tool: name, kind: fault.kind });
      this.setToolResult({ name, ok: false, data: { error: 'upstream timeout — the request may not have completed' } });
      return;
    }
    if (fault?.kind === 'malformed') {
      this.emit('fault_injected', { tool: name, kind: fault.kind });
      this.setToolResult({ name, ok: true, data: '{"saved": tr' }); // truncated JSON
      return;
    }
    this.setToolResult({ name, ok: out.ok, data: out.data });
  }

  private setToolResult(r: ToolResult): void {
    this.s.last_tool_result = r;
    this.emit('tool_result', { name: r.name, ok: r.ok, data: r.data });
    // Bill OCR is NOT evidence (same as production: a photo's numbers are only
    // verified once a ledger tool has echoed them back).
    if (r.name === 'read_bill') return;
    const ev = this.evidence();
    addToolResultEvidence(ev, JSON.stringify(r.data), { isError: !r.ok });
    this.saveEvidence(ev);
  }

  private doMessage(text: string): void {
    const decision = auditOutbound(text, this.evidence());
    const delivered = decision.action === 'deliver';
    const reasons = decision.action === 'hold' ? decision.reasons : [];
    this.emit('gate_decision', { action: decision.action, reasons });
    this.s.last_message = { delivered, gate_reasons: reasons };
    if (!delivered) return; // held: the owner never sees it, never answers it.

    this.emit('agent_message', { text });
    this.s.pending_owner = null;
    this.ownerResponds(text);
  }

  private ownerResponds(agentText: string): void {
    const script = this.scenario.owner_script;
    const asked = asksOwner(agentText);
    const next = script[this.s.owner_cursor];
    if (!next) {
      // Script exhausted. One exception: the agent asks the owner to re-confirm what they
      // already approved (the server guard refused a vague yes) — a real owner says yes again.
      if (asked && this.answerFromFacts(agentText)) return;
      this.s.done = true;
      return;
    }
    const hasDraft = this.s.ledger.entries.some((e) => e.status === 'draft' && !e.preexisting);
    const freshDraft = this.s.ledger.entries.some((e) => e.status === 'draft' && !e.preexisting && e.created_step > this.s.last_correction_step);
    const ok = (next.requires ?? []).every((r) => (r === 'draft' ? hasDraft : r === 'fresh_draft' ? freshDraft : asked));
    if (ok) {
      this.s.owner_cursor += 1;
      this.ownerSays(next);
      return;
    }
    if (asked && this.answerFromFacts(agentText)) return;
    if (asked && this.s.owner_nudges < OWNER_NUDGES) {
      this.s.owner_nudges += 1;
      this.ownerSays({
        say: 'It is for my business. Everything else is on the bill or in my message — please go ahead and prepare it.',
        intent: 'inform',
      });
      return;
    }
    this.s.owner_waiting = true;
  }

  /**
   * Owner simulator v2 (per fact, not per line): when asked something the script has no
   * line for, the owner answers from what they know — once each:
   *  - just approved a draft and is asked to confirm again → "Yes, save it."
   *  - the scenario's clarification fact (e.g. "I don't have the revised bill; use X").
   */
  private answerFromFacts(agentText: string): boolean {
    const drafts = this.s.ledger.entries.filter((e) => e.status === 'draft' && !e.preexisting);
    const pendingApproved = drafts.some((e) => this.s.approvals.includes(e.id));
    if (this.s.last_owner_intent === 'confirm' && pendingApproved && !this.s.owner_reaffirmed) {
      this.s.owner_reaffirmed = true;
      // A real owner reads the re-ask: if it names a bill they did NOT approve, they say no to the
      // widening instead of a blind "yes" (live finding 2026-10-10: consent widening).
      const text = agentText.toLowerCase();
      const widened = drafts.some((e) => !this.s.approvals.includes(e.id) && e.vendor_name && text.includes(e.vendor_name.toLowerCase()));
      if (widened) {
        const keep = drafts.find((e) => this.s.approvals.includes(e.id))?.vendor_name ?? 'the first one';
        this.ownerSays({ say: `No — only ${keep}. Not the other one.`, intent: 'inform' });
        return true;
      }
      this.ownerSays({ say: 'Yes, save it.', intent: 'inform' });
      return true;
    }
    // Only AFTER the owner has made the correction the fact answers (live run 2026-10-10: answering
    // the agent's first, unrelated question with it put the conversation out of order).
    if (this.scenario.clarify_answer && !this.s.clarify_answered && this.s.last_correction_step >= 0) {
      this.s.clarify_answered = true;
      this.ownerSays({ say: this.scenario.clarify_answer, intent: 'inform' });
      return true;
    }
    return false;
  }

  private ownerSays(line: OwnerLine): void {
    this.s.owner_waiting = false;
    this.s.last_owner_intent = line.intent === 'inform' && this.s.last_owner_intent === 'confirm' ? 'confirm' : line.intent;
    // The server-side guard's input: is this text an explicit yes? (Same pure fn as production.)
    if (isOwnerApproval(line.say)) this.s.owner_yes_steps.push(this.s.step);
    this.s.owner_texts.push(line.say);
    for (const f of line.attach ?? []) if (!this.s.attached.includes(f)) this.s.attached.push(f);
    this.s.pending_owner = line.say;

    if (line.intent === 'correct') {
      this.s.approvals = [];
      this.s.last_correction_step = this.s.step;
    }
    if (line.intent === 'confirm') {
      // The owner approves what is pending NOW (and was created after any correction).
      const pending = this.s.ledger.entries.filter(
        (e) => e.status === 'draft' && !e.preexisting && e.created_step > this.s.last_correction_step,
      );
      const approved = line.confirm_scope === 'first' ? pending.slice(0, 1) : pending;
      for (const e of approved) if (!this.s.approvals.includes(e.id)) this.s.approvals.push(e.id);
    }
    this.emit('owner_message', { text: line.say, intent: line.intent, attached: line.attach ?? [] });

    // New owner turn ⇒ fresh TOOL evidence; every figure the owner typed in this
    // conversation stays evidence (production's OwnerTextMemory, finding #5).
    const ev = newTurnEvidence();
    addOwnerFigures(ev, this.s.owner_texts.join('\n'));
    this.saveEvidence(ev);
  }

  private evidence() {
    const ev = newTurnEvidence();
    for (const n of this.s.evidence.numbers) ev.verifiedNumbers.add(n);
    ev.validationFailures.push(...this.s.evidence.failures);
    ev.toolErrors.push(...this.s.evidence.errors);
    return ev;
  }

  private saveEvidence(ev: ReturnType<typeof newTurnEvidence>): void {
    this.s.evidence = { numbers: [...ev.verifiedNumbers].sort(), failures: [...ev.validationFailures], errors: [...ev.toolErrors] };
  }
}

function summarizeAction(a: Action): Record<string, unknown> {
  if (a.type === 'tool') return { type: 'tool', name: a.name };
  if (a.type === 'message') return { type: 'message', chars: a.text.length };
  return { type: 'end' };
}
