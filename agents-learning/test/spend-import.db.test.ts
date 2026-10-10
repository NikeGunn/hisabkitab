/**
 * Model spend reaches the admin panel autonomously: a paid-run report (shipped in
 * research/paid-runs) is imported once, with its cost, and never double-counted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { importReport } from '../src/store/persist.js';

const LAB = process.env['LAB_TEST_DATABASE_URL'];
const ADMIN = process.env['LAB_TEST_ADMIN_DATABASE_URL'];
const run = LAB && ADMIN ? describe : describe.skip;
const DIR = fileURLToPath(new URL('../research/paid-runs/', import.meta.url));

run('paid-run import (Postgres)', () => {
  const admin = postgres(ADMIN as string, { max: 1, onnotice: () => {} });
  beforeEach(async () => {
    process.env['LAB_DATABASE_URL'] = LAB;
    await admin`TRUNCATE rehearsal.release_decisions, rehearsal.events, rehearsal.episodes, rehearsal.runs, rehearsal.training_runs`;
  });
  afterAll(async () => {
    await admin.end();
  });

  it('records every shipped paid run with its exact cost; a second sync adds nothing', async () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
    let expected = 0;
    for (const f of files) {
      const raw = readFileSync(DIR + f, 'utf8');
      expected += (JSON.parse(raw) as { cost_paisa: number }).cost_paisa;
      expect((await importReport(raw, f)).status).toBe('imported');
    }
    for (const f of files) expect((await importReport(readFileSync(DIR + f, 'utf8'), f)).status).toBe('skipped');
    const [t] = await admin<{ cost: string }[]>`SELECT coalesce(sum(cost_paisa),0)::text AS cost FROM rehearsal.episodes`;
    expect(Number(t!.cost)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('PROBE: archived paid runs never carry a test-split trajectory (hold-out stays local)', () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
      const r = JSON.parse(readFileSync(DIR + f, 'utf8')) as { cases: Array<{ split: string; episode: { events: unknown[] } }> };
      for (const c of r.cases) if (c.split === 'test') expect(c.episode.events).toEqual([]);
    }
  });

  it('PROBE: a file that is not an evaluation report is refused', async () => {
    await expect(importReport('{"hello":1}', 'bogus.json')).rejects.toThrow(/not an evaluation report/);
  });
});
