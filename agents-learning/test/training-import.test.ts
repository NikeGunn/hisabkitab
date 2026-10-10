import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { policyAgentFor, TrainingResult } from '../src/store/training-import.js';

const LAB_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('training import', () => {
  it('maps a Windows-trained weights path (backslashes, no prefix) to a policy agent', () => {
    expect(policyAgentFor('research\\weights\\grpo-v1_judge-seed0.json', LAB_ROOT)).toBe('policy:research/weights/grpo-v1_judge-seed0.json');
    expect(policyAgentFor('agents-learning/research/weights/grpo-v1_judge-seed0.json', LAB_ROOT)).toBe('policy:research/weights/grpo-v1_judge-seed0.json');
  });

  it('PROBE: a weights file that does not exist yields no agent (no test score is invented)', () => {
    expect(policyAgentFor('research/weights/does-not-exist.json', LAB_ROOT)).toBeUndefined();
  });

  it('PROBE: a malformed result file is rejected by the schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ name: 'x', curve: 'nope' }));
    expect(TrainingResult.safeParse({ name: 'x', curve: 'nope' }).success).toBe(false);
  });
});
