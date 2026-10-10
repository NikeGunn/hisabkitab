/**
 * PolicyAgent: a linear softmax policy over the skill harness.
 *
 *   logits = W · features        (W: 6 skills × 13 features = 78 numbers)
 *   π(skill | features) = softmax(logits)
 *
 * The weights are LEARNED by the Python research layer (agents-learning/research,
 * GRPO on the train split) and saved as JSON. Here we only run inference — greedy
 * (argmax) for evaluation, so a reported pass rate is deterministic.
 */
import { readFileSync } from 'node:fs';
import type { Action, Observation } from '../contracts.js';
import type { Agent } from './types.js';
import { FEATURES, SKILLS, SkillHarness, type Skill } from './skills.js';

export interface PolicyWeights {
  name: string;
  skills: readonly string[];
  features: readonly string[];
  W: number[][];
}

export function loadWeights(path: string): PolicyWeights {
  const w = JSON.parse(readFileSync(path, 'utf8')) as PolicyWeights;
  // Refuse weights trained against a different harness — silent misalignment would be a false result.
  if (w.skills.join() !== SKILLS.join() || w.features.join() !== FEATURES.join()) {
    throw new Error(`${path}: weights were trained for a different skill/feature layout`);
  }
  return w;
}

export function argmaxSkill(W: number[][], features: number[]): Skill {
  let best = 0;
  let bestScore = -Infinity;
  W.forEach((row, i) => {
    const score = row.reduce((s, w, j) => s + w * (features[j] ?? 0), 0);
    if (score > bestScore) [best, bestScore] = [i, score];
  });
  return SKILLS[best] as Skill;
}

export class PolicyAgent implements Agent {
  readonly id: string;
  readonly version: string;
  private harness = new SkillHarness('');
  private decisions: Array<{ features: number[]; skill: Skill }> = [];

  constructor(private readonly weights: PolicyWeights) {
    this.id = `policy:${weights.name}`;
    this.version = `linear-softmax/${weights.name}`;
  }

  begin(scenarioId: string): void {
    this.harness = new SkillHarness(scenarioId);
    this.decisions = [];
  }

  snapshot(): unknown {
    return { harness: this.harness.snapshot(), decisions: this.decisions };
  }

  restore(state: unknown): void {
    const s = state as { harness: unknown; decisions: PolicyAgent['decisions'] };
    this.harness.restore(s.harness);
    this.decisions = s.decisions;
  }

  async act(obs: Observation): Promise<{ action: Action; note?: string }> {
    for (;;) {
      const step = this.harness.next(obs);
      if (step.kind === 'action') return { action: step.action };
      if (step.kind === 'end') return { action: { type: 'end' } };
      const skill = argmaxSkill(this.weights.W, step.features);
      this.decisions.push({ features: step.features, skill });
      this.harness.choose(skill); // loop again: the chosen skill now yields its first action
    }
  }
}

/**
 * Hand-written weights encoding the product rules — an upper-bound reference
 * ("what should a perfect skill choice look like?") and a test of the harness.
 */
export function ruleWeights(): PolicyWeights {
  const W = SKILLS.map(() => FEATURES.map(() => 0));
  const set = (skill: Skill, feature: (typeof FEATURES)[number], v: number) => {
    W[SKILLS.indexOf(skill)]![FEATURES.indexOf(feature)] = v;
  };
  set('draft_and_ask', 'bias', 1);
  set('ask_clarify', 'amount_mismatch', 5);
  set('ask_clarify', 'bill_missing_vat_no', 5);
  set('confirm_pending', 'owner_yes', 3);
  set('confirm_pending', 'already_saved', 3);
  set('acknowledge', 'owner_no', 6);
  set('decline', 'other_business', 9);
  set('draft_and_ask', 'owner_correction', 4);
  set('ask_clarify', 'correction_unclarified', 6);
  return { name: 'rules', skills: SKILLS, features: FEATURES, W };
}
