import { ClaudeAgent, PROMPT_VARIANTS, type PromptVariant } from './claude.js';
import { CarefulAgent, EagerAgent } from './scripted.js';
import { loadWeights, PolicyAgent, ruleWeights } from './policy.js';
import type { Agent } from './types.js';

/**
 * Agent names used everywhere (CLI, worker, dashboard):
 *   careful | eager | claude | claude:<prompt-variant> | policy:rules | policy:<weights.json>
 */
/**
 * Real-model agents cost money, so they are LOCKED unless the operator opts in for
 * this run: LAB_ALLOW_MODEL_SPEND=true (or `--allow-spend` on the CLI). Scripted and
 * learned-policy agents are always free and always allowed.
 */
export function assertSpendAllowed(name: string): void {
  if (name.startsWith('claude') && process.env['LAB_ALLOW_MODEL_SPEND'] !== 'true') {
    throw new Error(`"${name}" calls the Anthropic API (costs money). Re-run with --allow-spend (and a --budget-rs cap) if you really mean it.`);
  }
}

export function makeAgent(name: string): Agent {
  assertSpendAllowed(name);
  if (name === 'careful') return new CarefulAgent();
  if (name === 'eager') return new EagerAgent();
  if (name === 'claude' || name.startsWith('claude:')) {
    const variant = (name.split(':')[1] ?? 'prod') as PromptVariant;
    if (!(variant in PROMPT_VARIANTS)) throw new Error(`unknown prompt variant "${variant}" (known: ${Object.keys(PROMPT_VARIANTS).join(', ')})`);
    return new ClaudeAgent({ variant });
  }
  if (name === 'policy:rules') return new PolicyAgent(ruleWeights());
  if (name.startsWith('policy:')) return new PolicyAgent(loadWeights(name.slice('policy:'.length)));
  throw new Error(`unknown agent "${name}" (careful | eager | claude | claude:<variant> | policy:rules | policy:<file>)`);
}

export const KNOWN_AGENTS = ['careful', 'eager', 'policy:rules', ...Object.keys(PROMPT_VARIANTS).map((v) => (v === 'prod' ? 'claude' : `claude:${v}`))];
