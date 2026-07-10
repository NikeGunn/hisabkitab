/** Test connection URLs (override via env; defaults match manual.txt local setup). */
export const ADMIN_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5432/hisabkitab_test';
/** App connects as hisab_app (NOSUPERUSER) so RLS is actually enforced in tests. */
export const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab_test';
/** Cross-tenant handle for the connector API (device-token world), like payments callback. */
export const ORCH_URL =
  process.env['TEST_ORCH_DATABASE_URL'] ??
  'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab_test';
