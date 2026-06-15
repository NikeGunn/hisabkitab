-- P8 identity & RBAC (PRD v2.0 §3): users + memberships, so several people can
-- share one business with distinct roles. The role is resolved server-side from
-- (verified WhatsApp number -> membership) and enforced in the MCP tools + RLS,
-- never from a tool argument or the model.
--
--   users         one verified WhatsApp identity (a phone can belong to many tenants)
--   memberships   user <-> tenant with a role + invite lifecycle
--
-- Backfill: every existing active tenant already has exactly one phone (its owner),
-- so we mint one user + one ACTIVE owner membership per such tenant in a single
-- set-based statement. This keeps every current session working (it resolves to
-- owner, matching today's implicit behaviour) with zero per-row code.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_e164 TEXT UNIQUE NOT NULL,         -- the verified identity (lookup key)
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  role       TEXT NOT NULL CHECK (role IN ('owner', 'accountant', 'staff', 'viewer')),
  status     TEXT NOT NULL DEFAULT 'invited'
             CHECK (status IN ('invited', 'active', 'revoked')),
  invited_by UUID REFERENCES users(id),       -- the owner who sent the invite
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most ONE live (invited|active) membership per (user, tenant); a revoked row
-- doesn't block a fresh invite. Partial unique index = the smallest correct index.
CREATE UNIQUE INDEX memberships_live_uq
  ON memberships (user_id, tenant_id) WHERE status <> 'revoked';

-- Access path for "who's on this business" / seat counts: tenant + status.
CREATE INDEX memberships_tenant_status_idx ON memberships (tenant_id, status);
-- Access path for "what businesses is this user on" (accountant multi-tenant, §4).
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ---------------------------------------------------------------- backfill (set-based)
-- One user row per existing active tenant phone…
INSERT INTO users (whatsapp_e164)
SELECT whatsapp_e164 FROM tenants
WHERE whatsapp_e164 IS NOT NULL AND status = 'active'
ON CONFLICT (whatsapp_e164) DO NOTHING;

-- …and an ACTIVE owner membership linking that user to its tenant.
INSERT INTO memberships (user_id, tenant_id, role, status)
SELECT u.id, t.id, 'owner', 'active'
FROM tenants t
JOIN users u ON u.whatsapp_e164 = t.whatsapp_e164
WHERE t.whatsapp_e164 IS NOT NULL AND t.status = 'active'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- Row-Level Security
-- `users` is global identity (a number can join many tenants), so it is NOT
-- tenant-scoped; only the orchestrator (hisab_orch) touches it, deny-by-default to
-- the tenant-scoped MCP role. `memberships` IS tenant-scoped for the MCP runtime.
ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

-- Orchestrator resolves identity + runs the invite flow across tenants.
CREATE POLICY orch_all ON users       TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON memberships TO hisab_orch USING (true) WITH CHECK (true);

-- The MCP runtime may read its own tenant's memberships (e.g. to list seats) but
-- never sees the global users table.
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------- least-privilege grants
-- hisab_orch is the tenancy trust root: it resolves identity, runs the invite
-- flow, AND honours tenant data-deletion (GDPR purge) — so it needs DELETE here.
GRANT SELECT, INSERT, UPDATE, DELETE ON users       TO hisab_orch;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO hisab_orch;
GRANT SELECT                         ON memberships TO hisab_app;   -- read-only seat lookups
