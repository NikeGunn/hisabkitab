/**
 * Sync the three repo skills (nepal-vat, nepal-tds, bill-extraction) to the
 * Skills API. Idempotent by display_title: an existing skill is reused as-is;
 * pass { forceNewVersion: true } to push the local SKILL.md as a new version.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import type { SkillRefs } from './definition.js';

export const SKILL_DIRS = ['nepal-vat', 'nepal-tds', 'bill-extraction', 'nepal-payments', 'accounts-reports'] as const;
type SkillDir = (typeof SKILL_DIRS)[number];

async function skillFiles(skillsRoot: string, dir: SkillDir) {
  const content = await readFile(join(skillsRoot, dir, 'SKILL.md'));
  // Path-style name keeps the required "one top-level directory with SKILL.md at root" layout.
  return [await toFile(content, `${dir}/SKILL.md`, { type: 'text/markdown' })];
}

export async function syncSkills(
  client: Anthropic,
  skillsRoot: string,
  opts: { forceNewVersion?: boolean } = {},
): Promise<SkillRefs> {
  const existing = new Map<string, string>(); // display_title -> skill_id
  for await (const skill of client.beta.skills.list({ source: 'custom' })) {
    if (skill.display_title) existing.set(skill.display_title, skill.id);
  }

  const ids = {} as Record<SkillDir, string>;
  for (const dir of SKILL_DIRS) {
    const found = existing.get(dir);
    if (found) {
      if (opts.forceNewVersion) {
        await client.beta.skills.versions.create(found, { files: await skillFiles(skillsRoot, dir) });
      }
      ids[dir] = found;
    } else {
      const created = await client.beta.skills.create({
        display_title: dir,
        files: await skillFiles(skillsRoot, dir),
      });
      ids[dir] = created.id;
    }
  }

  return {
    nepalVat: ids['nepal-vat'],
    nepalTds: ids['nepal-tds'],
    billExtraction: ids['bill-extraction'],
    nepalPayments: ids['nepal-payments'],
    accountsReports: ids['accounts-reports'],
  };
}
