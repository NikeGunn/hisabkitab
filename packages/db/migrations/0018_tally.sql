-- TallyPrime read-only integration (Phase T1) — connector binding, company catalog, job queue.
--
-- Design (see docs/TALLY-INTEGRATION.md):
--   * The customer-side connector NEVER accepts inbound connections; it long-polls us.
--     Its identity is a device token (SHA-256 hash at rest — the token itself is never
--     stored), minted through a short-lived setup code the owner types in once.
--   * One connector row is bound to exactly ONE tenant — the tenant_id on the row is the
--     ownership check for every company and job hanging off it.
--   * tally_jobs is the request/response queue between the tally MCP (hisab_app, RLS)
--     and the connector API (hisab_orch, cross-tenant like the payments callback).
--   * The operation CHECK repeats the allowlist enforced in the MCP tools and in the
--     connector: defense in depth — a compromised layer cannot widen the surface.
--   * READ-ONLY release: no table here can represent a Tally write, by construction.

-- One customer-side connector installation, bound to one tenant.
CREATE TABLE tally_connectors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  name                  TEXT NOT NULL DEFAULT 'TallyPrime connector',
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'revoked')),
  -- Easy setup: the owner types this short code into the connector once; registration
  -- consumes it and swaps it for a device token. Expired/consumed codes are useless.
  setup_code            TEXT UNIQUE,
  setup_code_expires_at TIMESTAMPTZ,
  -- SHA-256 hex of the device token (the token itself is shown once and never stored).
  token_hash            TEXT UNIQUE,
  connector_version     TEXT,
  capabilities          JSONB,
  last_seen_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Company catalog: every Tally company a connector has reported, with stable source
-- identity and freshness. Datasets are NEVER merged by name — (connector, source_id)
-- is the identity; is_bound marks the company the owner confirmed for queries.
CREATE TABLE tally_companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  connector_id    UUID NOT NULL REFERENCES tally_connectors(id),
  source_id       TEXT NOT NULL,   -- Tally company GUID when available, else name+books_from
  name            TEXT NOT NULL,
  books_from      DATE,
  last_voucher_on DATE,
  currency        TEXT NOT NULL DEFAULT 'NPR',
  is_bound        BOOLEAN NOT NULL DEFAULT false,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connector_id, source_id)
);

-- Job queue between the tally MCP tools (producer) and the connector (consumer).
CREATE TABLE tally_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  connector_id   UUID NOT NULL REFERENCES tally_connectors(id),
  operation      TEXT NOT NULL CHECK (operation IN
                   ('health', 'list_companies', 'search_ledgers',
                    'get_ledger_balance', 'get_receivables')),
  params         JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed', 'expired')),
  result         JSONB,
  error          TEXT,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);

CREATE INDEX tally_jobs_connector_status_idx ON tally_jobs (connector_id, status, created_at);
CREATE INDEX tally_companies_tenant_idx ON tally_companies (tenant_id);
CREATE INDEX tally_connectors_tenant_idx ON tally_connectors (tenant_id);

-- ---------------------------------------------------------------- Row-Level Security
-- Same fail-closed pattern as 0001/0007/0008: app.tenant_id from signed session metadata.
ALTER TABLE tally_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_companies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_jobs       ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tally_connectors
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON tally_companies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON tally_jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The connector API authenticates by device token, so it runs cross-tenant (hisab_orch),
-- exactly like the payments return-URL callback. DELETE is for the GDPR purge.
CREATE POLICY orch_all ON tally_connectors TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON tally_companies  TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON tally_jobs       TO hisab_orch USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- least-privilege grants
-- Tool side (hisab_app, tenant-scoped): issue/revoke connectors, refresh the catalog,
-- create jobs and read results; mark an abandoned job expired. Never DELETE.
GRANT SELECT, INSERT, UPDATE ON tally_connectors TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON tally_companies  TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON tally_jobs       TO hisab_app;

-- Connector API side (hisab_orch): find connector by token hash, heartbeat, consume
-- setup codes, claim jobs and post results; purge everything on tenant deletion.
GRANT SELECT, UPDATE, DELETE ON tally_connectors TO hisab_orch;
GRANT SELECT, UPDATE, DELETE ON tally_companies  TO hisab_orch;
GRANT SELECT, UPDATE, DELETE ON tally_jobs       TO hisab_orch;
