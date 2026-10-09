#!/bin/sh
# Create the two least-privilege application roles BEFORE migrations run.
# Migrations (run as the admin/postgres role) GRANT to these roles and define
# RLS policies that reference them, so they must exist first.
#
#   hisab_app  : tenant-scoped MCP runtime. NOSUPERUSER + NOBYPASSRLS so
#                Row-Level Security is actually enforced.
#   hisab_orch : cross-tenant orchestrator (webhook dedupe, pairing, callbacks,
#                scheduler). Also NOBYPASSRLS; gets explicit orch_all policies.
#
# A .sh init script (NOT .sql) because passwords must come from the environment:
# the previous 00-roles.sql hardcoded the dev passwords, so a prod stack whose
# services connect with $HISAB_*_PASSWORD could never authenticate — caught live
# on the first production probe (2026-07-06). compose.yaml passes both vars to
# the postgres container; dev keeps the same defaults as compose.dev/.env.example.
#
# NOTE: initdb scripts run ONLY on a fresh data volume. On an existing volume a
# password change requires a manual ALTER ROLE (documented in docs/DEPLOY.md).
set -eu

APP_PW="${HISAB_APP_PASSWORD:-hisab_app_dev}"
ORCH_PW="${HISAB_ORCH_PASSWORD:-hisab_orch_dev}"
LAB_PW="${HISAB_LAB_PASSWORD:-hisab_lab_dev}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hisab_app') THEN
    CREATE ROLE hisab_app LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE hisab_app LOGIN PASSWORD '${APP_PW}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hisab_orch') THEN
    CREATE ROLE hisab_orch LOGIN PASSWORD '${ORCH_PW}' NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE hisab_orch LOGIN PASSWORD '${ORCH_PW}';
  END IF;
  -- Rehearsal Lab worker: only ever granted the rehearsal schema (migration 0024).
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hisab_lab') THEN
    CREATE ROLE hisab_lab LOGIN PASSWORD '${LAB_PW}' NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE hisab_lab LOGIN PASSWORD '${LAB_PW}';
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO hisab_app, hisab_orch, hisab_lab;
SQL
