import type { Action, Observation } from '../contracts.js';

/** Token/cost accounting an agent reports per decision (0 for scripted agents). */
export interface DecisionUsage {
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  /** Exact cost of this decision incl. prompt-cache discounts (paisa). */
  cost_paisa?: number;
}

/**
 * An agent sees only Observations and returns Actions. Its private memory must be
 * serialisable (snapshot/restore) so a crashed run resumes with the same mind —
 * not a "magically preserved" process.
 */
export interface Agent {
  readonly id: string;
  readonly version: string;
  begin(scenarioId: string): void;
  act(obs: Observation): Promise<{ action: Action; usage?: DecisionUsage; note?: string }>;
  snapshot(): unknown;
  restore(state: unknown): void;
}
