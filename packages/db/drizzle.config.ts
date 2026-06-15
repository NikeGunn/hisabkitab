import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config, used for Drizzle Studio (the browser DB viewer):
 *   pnpm --filter @hisab/db studio     # then open the printed https://local.drizzle.studio URL
 *
 * Studio connects with whatever DATABASE_URL is set. For the Docker Compose dev
 * stack that is the admin or hisab_app connection on localhost:5432. We do NOT
 * generate or push migrations with drizzle-kit (the hand written SQL in
 * migrations/ is the source of truth, since it carries RLS + grants drizzle
 * cannot express); Studio is read/inspect only here.
 */
export default defineConfig({
  schema: './src/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ??
      process.env['ADMIN_DATABASE_URL'] ??
      'postgres://postgres:postgres@localhost:5432/hisabkitab',
  },
  // migrations/ holds the authoritative SQL; keep drizzle-kit out of that dir.
  out: './.drizzle-kit-scratch',
  verbose: true,
  strict: true,
});
