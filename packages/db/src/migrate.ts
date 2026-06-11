/**
 * Minimal, deterministic migration runner. Applies migrations/*.sql in name order,
 * each in its own transaction, tracked in _migrations. Runs on the ADMIN connection
 * (DDL + grants need it); the app itself never gets DDL rights.
 *
 *   ADMIN_DATABASE_URL=postgres://postgres:...@localhost:5432/hisabkitab pnpm migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrate(adminUrl: string): Promise<string[]> {
  const sql = postgres(adminUrl, { max: 1 });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await sql`SELECT name FROM _migrations`).map((r) => r.name as string));
    for (const file of files) {
      if (done.has(file)) continue;
      const content = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }
    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun) {
  const url = process.env['ADMIN_DATABASE_URL'];
  if (!url) {
    console.error('ADMIN_DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
