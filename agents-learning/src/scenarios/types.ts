import type { Family, Split, ToolName } from '../contracts.js';

/** A synthetic bill as the agent would receive it after OCR. Untrusted text. */
export interface BillDoc {
  file_id: string;
  ocr_text: string;
}

export type OwnerIntent = 'request' | 'confirm' | 'reject' | 'correct' | 'inform';

/**
 * One scripted owner message. The owner only says it once its `requires`
 * conditions hold after an agent message — e.g. a "yes, save it" is only said
 * when a draft exists AND the agent actually asked something.
 */
export interface OwnerLine {
  say: string;
  intent: OwnerIntent;
  attach?: string[];
  requires?: Array<'draft' | 'question'>;
  /** For intent=confirm: approve every pending draft, or only the oldest one. */
  confirm_scope?: 'all' | 'first';
}

export interface ExpectedEntry {
  type: 'sale' | 'expense';
  total_paisa: number;
  taxable_paisa: number;
  vat_paisa: number;
}

/** HIDDEN. Only the judge reads it — never the agent, never a tool. */
export interface Oracle {
  expected_confirmed: ExpectedEntry[];
  must_clarify_before_draft: boolean;
  must_decline: boolean;
  /** Strings whose appearance in tool arguments means another business was targeted. */
  foreign_markers: string[];
  /** Upper bound on drafts a correct trajectory creates (null = no bound checked). */
  max_drafts: number | null;
  rubric: string;
}

/** Fault injected into a sandbox tool call (failure-recovery scenarios). */
export interface Fault {
  tool: ToolName;
  on_call: number;
  /** timeout = nothing happened; ack_lost = it DID happen but the reply was lost; malformed = garbage reply. */
  kind: 'timeout' | 'ack_lost' | 'malformed';
}

/** An entry already in the books before the episode starts (duplicate scenarios). */
export interface ExistingEntry {
  type: 'sale' | 'expense';
  total_paisa: number;
  taxable_paisa: number;
  vat_paisa: number;
  vendor_name: string;
  invoice_no: string;
  occurred_on: string;
}

export interface Scenario {
  id: string;
  family: Family;
  difficulty: 1 | 2 | 3 | 4 | 5;
  split: Split;
  seed: number;
  dataset_version: string;
  /** Frozen clock for the episode (YYYY-MM-DD). */
  as_of: string;
  tenant: { id: string; name: string };
  bills: Record<string, BillDoc>;
  owner_script: OwnerLine[];
  existing: ExistingEntry[];
  faults: Fault[];
  oracle: Oracle;
}

/** What a catalog viewer may see: the oracle is stripped. */
export type PublicScenario = Omit<Scenario, 'oracle'>;
