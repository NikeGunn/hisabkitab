-- Create the two least-privilege application roles BEFORE migrations run.
-- Migrations (run as the admin/postgres role) GRANT to these roles and define
-- RLS policies that reference them, so they must exist first.
--
--   hisab_app  : tenant-scoped MCP runtime. NOSUPERUSER + NOBYPASSRLS so
--                Row-Level Security is actually enforced.
--   hisab_orch : cross-tenant orchestrator (webhook dedupe, pairing, callbacks,
--                scheduler). Also NOBYPASSRLS; gets explicit orch_all policies.
--
-- Passwords here are DEV defaults (matched in compose.dev.yaml + .env.example).
-- In prod, compose.prod.yaml injects real passwords via env and this file is a
-- no-op because the roles are created idempotently with the provided values.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hisab_app') THEN
    CREATE ROLE hisab_app LOGIN PASSWORD 'hisab_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hisab_orch') THEN
    CREATE ROLE hisab_orch LOGIN PASSWORD 'hisab_orch_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Allow both roles to connect to the application database.
GRANT CONNECT ON DATABASE hisabkitab TO hisab_app, hisab_orch;
