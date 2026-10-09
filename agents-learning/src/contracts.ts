/**
 * Rehearsal Lab contracts — the typed boundary between an agent, the rehearsal
 * environment and the judge. Everything an agent may SEE is in `Observation`;
 * everything it may DO is an `Action`. The oracle (hidden expected outcome) is
 * never part of either: only the judge reads it.
 *
 * Money crosses this boundary as integer paisa numbers, exactly like the real
 * ledger MCP tools (packages/mcp-ledger/src/tools.ts).
 */
import { z } from 'zod';

export const FAMILIES = [
  'bill_extraction',
  'draft_only',
  'confirmation',
  'correction',
  'contradiction',
  'missing_fields',
  'duplicate_bill',
  'cross_tenant',
  'receipt_injection',
  'tool_failure',
  'vat_edge',
  'multi_turn',
] as const;
export type Family = (typeof FAMILIES)[number];

export type Split = 'train' | 'dev' | 'test';

/** Tools the rehearsal ledger offers — same names + semantics as the production ledger MCP. */
export const TOOL_NAMES = [
  'read_bill',
  'record_expense',
  'record_sale',
  'confirm_entry',
  'validate_entry',
  'compute_vat',
  'list_transactions',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool'),
    name: z.enum(TOOL_NAMES),
    args: z.record(z.string(), z.unknown()),
  }),
  // A message to the owner. It passes the REAL pre-delivery Audit Gate first.
  z.object({ type: z.literal('message'), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('end') }),
]);
export type Action = z.infer<typeof ActionSchema>;

export interface ToolResult {
  name: ToolName;
  ok: boolean;
  /** JSON-serialisable payload (or an error object when ok=false). */
  data: unknown;
}

export interface Observation {
  episode_id: string;
  step: number;
  /** Newest owner message the agent has not answered yet (null = nothing new). */
  owner_message: string | null;
  /** Bills the owner attached so far (content is read via the read_bill tool). */
  bills: string[];
  tool_result: ToolResult | null;
  /** Outcome of the agent's last message: delivered, or HELD by the Audit Gate. */
  last_message: { delivered: boolean; gate_reasons: string[] } | null;
  /** True when the owner has nothing more to say and is waiting. */
  owner_waiting: boolean;
  tools: readonly ToolName[];
}

/** Append-only event — the trajectory. Ordered by `seq`, never mutated. */
export type EventKind =
  | 'episode_reset'
  | 'owner_message'
  | 'agent_decision'
  | 'tool_call'
  | 'tool_result'
  | 'fault_injected'
  | 'ledger_write'
  | 'gate_decision'
  | 'agent_message'
  | 'cross_tenant_attempt'
  | 'invalid_action'
  | 'episode_end';

export interface LabEvent {
  seq: number;
  kind: EventKind;
  data: Record<string, unknown>;
}

export interface StepInfo {
  events: LabEvent[];
  error?: string;
}

export type StepResult = [obs: Observation, reward: number, terminated: boolean, truncated: boolean, info: StepInfo];
