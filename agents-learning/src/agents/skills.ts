/**
 * Skill harness: the policy decides WHAT to do; the harness decides HOW.
 *
 * At every owner turn the harness turns the observation into a small feature
 * vector and asks a policy to pick one SKILL. The harness then executes that
 * skill as real tool calls + one message to the owner (reading bills, drafting
 * with an idempotency key, retrying a failed write with the SAME key, showing
 * tool-verified figures). The policy never writes JSON or touches a tool.
 *
 * That split is what makes a tiny policy trainable by RL in seconds on a CPU,
 * and it mirrors production: the model chooses, code executes.
 */
import { HELD_FALLBACK_MESSAGE } from '@hisab/orchestrator';
import type { Action, Observation } from '../contracts.js';
import { amountsIn, foreignRequest, holdOff, npr, parseBill, saysCorrection, saysNo, saysYes, type ParsedBill } from './parse.js';

export const SKILLS = ['draft_and_ask', 'draft_and_save', 'ask_clarify', 'confirm_pending', 'decline', 'acknowledge'] as const;
export type Skill = (typeof SKILLS)[number];

export const FEATURES = [
  'bias',
  'new_request',
  'owner_yes',
  'owner_no',
  'owner_correction',
  'owner_hold_off',
  'other_business',
  'amount_mismatch',
  'bill_missing_vat_no',
  'pending_draft',
  'duplicate_warning',
  'already_saved',
] as const;
export type Feature = (typeof FEATURES)[number];

export type HarnessStep = { kind: 'action'; action: Action } | { kind: 'decide'; features: number[] } | { kind: 'end' };

interface Draft {
  id: string;
  type: 'sale' | 'expense';
  total: number;
  vendor: string | null;
  file: string | null;
  confirmed: boolean;
  superseded: boolean;
  duplicate: boolean;
}

type Write = { name: 'record_expense' | 'record_sale'; args: Record<string, unknown> };

/** How a drafting skill finishes once its drafts exist: show-and-ask (safe) or save at once (unsafe shortcut). */
type Closing = 'ask' | 'save';

interface Memory {
  scenario: string;
  owner: string;
  bills: ParsedBill[];
  drafts: Draft[];
  queue: Action[];
  writes: Write[];
  inflight: (Write & { retries: number }) | null;
  closing: Closing | null;
  answered_vat: boolean | null;
  confirmed_amount: number | null;
  keys: number;
  awaiting_owner: boolean;
  decided: boolean;
}

export class SkillHarness {
  private m: Memory;

  constructor(scenario: string) {
    this.m = {
      scenario,
      owner: '',
      bills: [],
      drafts: [],
      queue: [],
      writes: [],
      inflight: null,
      closing: null,
      answered_vat: null,
      confirmed_amount: null,
      keys: 0,
      awaiting_owner: true,
      decided: false,
    };
  }

  snapshot(): unknown {
    return structuredClone(this.m);
  }

  restore(state: unknown): void {
    this.m = structuredClone(state as Memory);
  }

  /** Advance one step: an action to execute, a request for a policy decision, or the end. */
  next(obs: Observation): HarnessStep {
    const m = this.m;
    this.absorbToolResult(obs);

    if (m.inflight) return act({ type: 'tool', name: m.inflight.name, args: m.inflight.args });
    const write = m.writes.shift();
    if (write) {
      m.inflight = { ...write, retries: 0 };
      return act({ type: 'tool', name: write.name, args: write.args });
    }
    if (m.closing) {
      m.queue.push(...CLOSINGS[m.closing](m));
      m.closing = null;
    }
    const queued = m.queue.shift();
    if (queued) {
      if (queued.type === 'message') m.awaiting_owner = true;
      return act(queued);
    }

    if (m.awaiting_owner && obs.last_message?.delivered === false) {
      // The Audit Gate HELD our message (a figure it could not verify). Do what
      // production does after a hold: send a figure-free fallback, never re-decide on
      // the same owner message.
      return act(say(HELD_FALLBACK_MESSAGE));
    }
    if (m.awaiting_owner) {
      if (obs.owner_message === null) return { kind: 'end' };
      m.awaiting_owner = false;
      m.decided = false;
      this.absorbOwner(obs.owner_message);
    }
    // Reading an attached bill is read-only, so the harness always does it first.
    const unread = obs.bills.find((f) => !m.bills.some((b) => b.file_id === f));
    if (unread) return act({ type: 'tool', name: 'read_bill', args: { file_id: unread } });

    return m.decided ? { kind: 'end' } : { kind: 'decide', features: this.features() };
  }

  /** Execute the policy's choice for this owner turn. */
  choose(skill: Skill): void {
    const m = this.m;
    m.decided = true;
    switch (skill) {
      case 'draft_and_ask':
      case 'draft_and_save':
        m.writes = this.plannedWrites();
        m.closing = skill === 'draft_and_ask' ? 'ask' : 'save';
        return;
      case 'ask_clarify':
        m.queue.push(say(clarifyQuestion(m)));
        return;
      case 'confirm_pending':
        m.queue.push(...save(m, /\bonly the first\b/i.test(m.owner) ? firstMentioned(m) : open(m)));
        return;
      case 'decline':
        m.queue.push(say("Sorry, I can only work with this business's own accounts. Anything in your own books I can help with?"));
        return;
      case 'acknowledge':
        m.queue.push(say("Okay, I won't save anything for now."));
        return;
    }
  }

  /** What the policy sees: 12 yes/no facts derived from the observation only (never the oracle). */
  features(): number[] {
    const m = this.m;
    const t = m.owner;
    const ownerAmount = amountsIn(t)[0];
    const bill = m.bills.find((b) => !m.drafts.some((d) => d.file === b.file_id && !d.superseded));
    const pending = open(m);
    const f: Record<Feature, boolean> = {
      bias: true,
      new_request: /\b(add|record|note|sold|bills?)\b/i.test(t) && !saysYes(t),
      owner_yes: saysYes(t),
      owner_no: saysNo(t),
      owner_correction: saysCorrection(t),
      owner_hold_off: holdOff(t),
      other_business: foreignRequest(t),
      amount_mismatch:
        bill !== undefined && ownerAmount !== undefined && bill.total_paisa !== null && ownerAmount !== bill.total_paisa && !/my mistake|bill is right/i.test(t),
      bill_missing_vat_no: bill !== undefined && !bill.vat_registered && m.answered_vat === null,
      pending_draft: pending.length > 0,
      duplicate_warning: pending.some((d) => d.duplicate),
      already_saved: m.drafts.some((d) => d.confirmed) && pending.length === 0,
    };
    return FEATURES.map((k) => (f[k] ? 1 : 0));
  }

  // ---------------------------------------------------------------- perception

  private absorbOwner(text: string): void {
    const m = this.m;
    m.owner = text;
    if (/not vat registered/i.test(text)) m.answered_vat = false;
    if (/my mistake|bill is right/i.test(text)) m.confirmed_amount = amountsIn(text)[0] ?? null;
    if (saysCorrection(text)) for (const d of open(m)) d.superseded = true;
  }

  private absorbToolResult(obs: Observation): void {
    const r = obs.tool_result;
    const m = this.m;
    if (!r) return;
    if (r.name === 'read_bill' && r.ok) {
      const d = r.data as { file_id: string; ocr_text: string };
      if (!m.bills.some((b) => b.file_id === d.file_id)) m.bills.push(parseBill(d.file_id, d.ocr_text));
      return;
    }
    if ((r.name !== 'record_expense' && r.name !== 'record_sale') || !m.inflight) return;
    const data = r.data;
    if (!r.ok || typeof data !== 'object' || data === null) {
      // Timeout or garbage: retry the SAME call (same idempotency key) — never a fresh one.
      if (++m.inflight.retries > 2) m.inflight = null;
      return;
    }
    const d = data as Record<string, unknown>;
    if (d['saved'] === true) {
      const checks = (d['validation'] as { results?: Array<{ check: string; result: string }> } | undefined)?.results ?? [];
      m.drafts.push({
        id: String(d['expense_id'] ?? d['sale_id']),
        type: r.name === 'record_sale' ? 'sale' : 'expense',
        total: Number(d['total_paisa']),
        vendor: (m.inflight.args['vendor_name'] as string | undefined) ?? null,
        file: (m.inflight.args['receipt_file_id'] as string | undefined) ?? null,
        confirmed: false,
        superseded: false,
        // A correction re-drafts the same invoice; that echo is not a real duplicate.
        duplicate: !m.drafts.some((x) => x.superseded) && checks.some((c) => c.check === 'duplicate' && c.result !== 'pass'),
      });
    }
    m.inflight = null;
  }

  // ---------------------------------------------------------------- planning

  /** One write per thing the owner asked to record: a correction, each undrafted bill, or a typed entry. */
  private plannedWrites(): Write[] {
    const m = this.m;
    const t = m.owner;
    const correction = saysCorrection(t) ? amountsIn(t)[0] : undefined;
    let writes: Write[];
    if (correction !== undefined) {
      writes = [{ name: 'record_expense', args: expenseArgs(m.bills[0] ?? null, correction, true) }];
    } else {
      writes = m.bills
        .filter((b) => !m.drafts.some((d) => d.file === b.file_id && !d.superseded))
        .map((b) => ({ name: 'record_expense', args: expenseArgs(b, m.confirmed_amount ?? b.total_paisa ?? 0, b.vat_registered && m.answered_vat !== false) }));
      const amount = amountsIn(t)[0];
      if (m.bills.length === 0 && amount !== undefined && m.drafts.length === 0) writes.push(typedEntry(t, amount));
    }
    return writes.map((w) => ({ name: w.name, args: { ...w.args, idempotency_key: `${m.scenario}:${++m.keys}` } }));
  }
}

// ------------------------------------------------------------------ helpers

const act = (action: Action): HarnessStep => ({ kind: 'action', action });
const say = (text: string): Action => ({ type: 'message', text });
const open = (m: Memory) => m.drafts.filter((d) => !d.confirmed && !d.superseded);
const list = (ds: Draft[]) => ds.map((d) => `${d.vendor ?? d.type}: ${npr(d.total)}`).join(', ');

/** Confirm these drafts, then tell the owner (figures come from the drafts' tool results). */
function save(m: Memory, drafts: Draft[]): Action[] {
  if (drafts.length === 0) return [say('That is already saved — nothing more to do.')];
  const confirms: Action[] = drafts.map((d) => ({ type: 'tool', name: 'confirm_entry', args: { entry_type: d.type, entry_id: d.id } }));
  for (const d of drafts) d.confirmed = true;
  return [...confirms, say(`Saved ✅ ${list(drafts)}`)];
}

const CLOSINGS: Record<Closing, (m: Memory) => Action[]> = {
  ask: (m) => {
    const ds = open(m);
    if (ds.length === 0) return [say('I could not prepare a draft from that. Could you check the details?')];
    const dup = ds.some((d) => d.duplicate) ? ' This looks like a bill already in your books.' : '';
    return [say(`I prepared: ${list(ds)}.${dup} Shall I save it?`)];
  },
  save: (m) => save(m, open(m)),
};

function clarifyQuestion(m: Memory): string {
  const ownerAmount = amountsIn(m.owner)[0];
  const bill = m.bills[0];
  if (bill && ownerAmount !== undefined && ownerAmount !== bill.total_paisa) {
    return `The bill's total does not match the ${npr(ownerAmount)} you mentioned. Which amount is correct?`;
  }
  if (bill && !bill.vat_registered) return `The bill from ${bill.vendor} has no PAN/VAT number. Is this vendor VAT registered?`;
  return 'Could you confirm the details before I record this?';
}

function firstMentioned(m: Memory): Draft[] {
  const t = m.owner.toLowerCase();
  const ds = open(m);
  const hit = ds.find((d) => d.vendor && t.includes(d.vendor.toLowerCase()));
  return hit ? [hit] : ds.slice(0, 1);
}

function expenseArgs(b: ParsedBill | null, total: number, vatRegistered: boolean): Record<string, unknown> {
  return {
    occurred_on: b?.date ?? '2026-09-20',
    amount_paisa: total,
    inclusive: true,
    vendor_is_vat_registered: vatRegistered,
    is_service: false,
    for_taxable_business_use: true,
    ...(b ? { vendor_name: b.vendor, receipt_file_id: b.file_id } : {}),
    ...(b?.invoice_no ? { invoice_no: b.invoice_no } : {}),
  };
}

function typedEntry(text: string, amount: number): Write {
  if (/\bsold\b/i.test(text)) {
    return { name: 'record_sale', args: { occurred_on: '2026-09-20', amount_paisa: amount, inclusive: !/plus 13% vat/i.test(text), payment_method: 'cash' } };
  }
  return {
    name: 'record_expense',
    args: {
      occurred_on: /on (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? '2026-09-20',
      amount_paisa: amount,
      inclusive: true,
      vendor_is_vat_registered: !/not vat registered/i.test(text),
      is_service: /rent/i.test(text),
      for_taxable_business_use: true,
    },
  };
}
