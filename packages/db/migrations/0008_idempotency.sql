-- P9 (PRD v2.0 §6, §15): idempotent write keys for entry-creating MCP tools.
-- A repeat call with the same client-supplied key returns the ORIGINAL result and
-- never inserts a second row. This is the tool-layer companion to the already-built
-- inbound dedupe (wa_events), allocation row-locks, and Khalti pidx latch.
--
-- The row is written by the RLS app role inside the SAME tenant transaction as the
-- entry it guards (one tx → key + entry commit or roll back together). So it carries
-- tenant_id + RLS + a hisab_app grant, exactly like the 0007 AR/AP tables.
--
-- The key IDENTITY is composite (tenant_id, scope, key), NOT a global `key`. The
-- PRD §15 sketch used `key PRIMARY KEY`, but agents may reuse short/literal keys, so
-- a global PK would let one tenant's key collide with another's — making the second
-- tenant's genuine write spuriously dedupe. Tenant-scoping the PK closes that.

CREATE TABLE idempotency_keys (
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  scope      TEXT NOT NULL,                    -- the tool name, e.g. 'record_sale'
  key        TEXT NOT NULL,                    -- client-supplied (uuid / wa msg id / pidx)
  result     JSONB NOT NULL,                   -- the exact result returned the first time
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, key)          -- exactly-once backstop, per tenant
);

-- ---------------------------------------------------------------- Row-Level Security
-- Same fail-closed pattern as 0001/0007: app.tenant_id from signed session metadata only.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------- least-privilege grants
-- Keys are append-only for the app: written once, read on replay; never updated/deleted.
GRANT SELECT, INSERT ON idempotency_keys TO hisab_app;
