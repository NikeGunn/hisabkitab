/**
 * One RL episode at the granularity a policy actually decides: "the owner just
 * spoke — which skill now?". The harness + env run everything in between.
 *
 *   reset()  → features of the first decision point
 *   choose() → runs that skill until the next decision point (or the end)
 *
 * The full verdict comes back at the end so the TRAINER chooses how to turn it
 * into a reward (that choice is the research question, so it lives in Python).
 */
import type { Observation } from '../contracts.js';
import { RehearsalEnv } from '../env/environment.js';
import type { Verdict } from '../judge/judge.js';
import { SKILLS, SkillHarness, type Skill } from '../agents/skills.js';

export interface DecisionPoint {
  done: boolean;
  features: number[] | null;
  verdict: Verdict | null;
}

/** No scenario needs more than a handful of decisions; a policy looping past this is cut off. */
const MAX_DECISIONS = 8;

export class RlSession {
  private decisions = 0;
  private readonly env = new RehearsalEnv();
  private readonly harness: SkillHarness;
  private obs: Observation;

  constructor(scenarioId: string) {
    [this.obs] = this.env.reset({ scenario_id: scenarioId });
    this.harness = new SkillHarness(scenarioId);
  }

  reset(): DecisionPoint {
    return this.advance();
  }

  choose(skillIndex: number): DecisionPoint {
    const skill = SKILLS[skillIndex];
    if (skill === undefined) throw new Error(`skill index ${skillIndex} out of range 0..${SKILLS.length - 1}`);
    this.harness.choose(skill as Skill);
    this.decisions += 1;
    return this.advance();
  }

  /** Run actions until the policy is needed again, or the episode ends. */
  private advance(): DecisionPoint {
    while (!this.env.state.done) {
      const step = this.harness.next(this.obs);
      if (step.kind === 'decide') {
        if (this.decisions < MAX_DECISIONS) return { done: false, features: step.features, verdict: null };
        [this.obs] = this.env.step({ type: 'end' });
        continue;
      }
      [this.obs] = this.env.step(step.kind === 'action' ? step.action : { type: 'end' });
    }
    return { done: true, features: null, verdict: this.env.state.verdict };
  }
}
