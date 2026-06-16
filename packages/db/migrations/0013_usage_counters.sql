-- P11 cost controls (PRD v2.0 §7): per-tenant monthly usage accounting so the
-- orchestrator can soft-warn then throttle a tenant that exceeds its plan's model
-- budget, and so ops can track cost-per-tenant vs revenue-per-tenant.
--
-- One row per (tenant, period). `period` is a BS-aligned 'YYYY-MM' string (the
-- billing month) so a tenant's spend window matches their subscription period.
-- Counters are MONOTONIC within a period and accumulate via an idempotent upsert
-- (ON CONFLICT … DO UPDATE … += new). cost_paisa is integer paisa (CLAUDE.md §3),
-- never a float.
--
-- WRITTEN BY hisab_orch (cross-tenant), like wa_events / reminder_log: usage is
-- recorded in the orchestrator's turn path, not via an RLS tool. The agent's
-- read-only `get_cost_summary` tool reads it tenant-scoped as hisab_app.

CREATE TABLE usage_counters (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  period      TEXT NOT NULL,                       -- billing month, e.g. '2026-06'
  turns       BIGINT NOT NULL DEFAULT 0 CHECK (turns >= 0),
  input_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens  >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_paisa  BIGINT NOT NULL DEFAULT 0 CHECK (cost_paisa >= 0),
  -- soft-warn latch: once we have nudged the owner this period, don't nudge again.
  warned_at   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

CREATE INDEX usage_counters_period_idx ON usage_counters (period);

-- ---------------------------------------------------------------- Row-Level Security
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped read for the MCP runtime (hisab_app) — the get_cost_summary tool.
CREATE POLICY tenant_isolation ON usage_counters
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cross-tenant for hisab_orch: it RECORDS usage every turn (upsert) and reads the
-- whole table for the spend dashboard / anomaly scan, mirroring reminder_log.
CREATE POLICY orch_all ON usage_counters TO hisab_orch USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- least-privilege grants
-- app only SELECTs (the read-only cost tool); orch records usage (INSERT/UPDATE) and
-- purges it on a tenant data-deletion request (DELETE), like its other tenant tables.
GRANT SELECT ON usage_counters TO hisab_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_counters TO hisab_orch;
