/** Reset the test database to a clean migrated state once per test run. */
import postgres from 'postgres';
import { migrate } from '@hisab/db';
import { ADMIN_URL } from './urls.js';

export default async function setup(): Promise<void> {
  const sql = postgres(ADMIN_URL, { max: 1 });
  try {
    await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await sql.end({ timeout: 5 });
  }
  await migrate(ADMIN_URL);
}
