/**
 * The versioned scenario catalog: FAMILIES × INSTANCES_PER_FAMILY deterministic
 * scenarios, stratified into train / dev / test inside every family so each split
 * covers all 12 behaviours. The test split is the frozen hold-out: nothing trains
 * or tunes on it, and it is never exported to an external service.
 *
 * Bump DATASET_VERSION whenever a generator or the split rule changes — results
 * are only comparable within one version.
 */
import { FAMILIES, type Family, type Split } from '../contracts.js';
import { fnv1a } from '../rng.js';
import { sha256Hex, stableJson } from '../hash.js';
import { generate } from './families.js';
import type { PublicScenario, Scenario } from './types.js';

/** Results are comparable only within one version. v1.1: correction family follows the 2026-10-10 human ruling. */
export const DATASET_VERSION = 'rehearsal-v1.1';
/** Seeds stay on the v1 namespace so every scenario keeps its numbers across label bumps. */
const SEED_NAMESPACE = 'rehearsal-v1';
export const INSTANCES_PER_FAMILY = 10;
/** Per family: 6 train, 2 dev, 2 test (by a seeded hash order, not by index). */
const SPLIT_PLAN: readonly Split[] = ['train', 'train', 'train', 'train', 'train', 'train', 'dev', 'dev', 'test', 'test'];

export function scenarioSeed(family: Family, instance: number): number {
  return fnv1a(`${SEED_NAMESPACE}:${family}:${instance}`);
}

function familyScenarios(family: Family): Scenario[] {
  const instances = Array.from({ length: INSTANCES_PER_FAMILY }, (_, i) => i);
  const order = [...instances].sort(
    (a, b) => fnv1a(`split:${family}:${a}`) - fnv1a(`split:${family}:${b}`) || a - b,
  );
  return instances.map((i) => {
    const seed = scenarioSeed(family, i);
    return {
      id: `${family}/${String(i).padStart(3, '0')}`,
      family,
      split: SPLIT_PLAN[order.indexOf(i)] as Split,
      seed,
      dataset_version: DATASET_VERSION,
      ...generate(family, seed),
    };
  });
}

let cached: Scenario[] | undefined;

export function catalog(): Scenario[] {
  cached ??= FAMILIES.flatMap(familyScenarios);
  return cached;
}

export function getScenario(id: string): Scenario {
  const s = catalog().find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}

export function scenariosFor(split: Split | 'all', family?: Family): Scenario[] {
  return catalog().filter((s) => (split === 'all' || s.split === split) && (!family || s.family === family));
}

/** The 12-case golden smoke set: instance 000 of every family. */
export function goldenSet(): Scenario[] {
  return catalog().filter((s) => s.id.endsWith('/000'));
}

export function toPublic(s: Scenario): PublicScenario {
  const { oracle: _hidden, ...rest } = s;
  void _hidden;
  return rest;
}

/** Content hash of the whole dataset (incl. oracles) — recorded on every run. */
export function datasetHash(): string {
  return sha256Hex(stableJson(catalog()));
}
