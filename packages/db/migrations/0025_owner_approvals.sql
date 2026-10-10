-- 0025: server-side confirm-before-save (Rehearsal Lab finding #1).
--
-- Until now "nothing is saved without the owner's yes" was enforced only by the
-- system prompt: confirm_entry never checked that the owner had approved. Now the
-- orchestrator records an approval when a VERIFIED inbound owner message is an
-- explicit yes (pure classifier @hisab/shared isOwnerApproval; only for members
-- whose role may confirm), and every ledger confirm tool refuses unless an
-- approval exists that is NEWER than the draft and at most 30 minutes old.
-- The model cannot write this table: only hisab_orch inserts, hisab_app reads.

CREATE TABLE owner_approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  wa_message_id TEXT NOT NULL,
  user_id       UUID,
  approved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_message_id)
);

CREATE INDEX owner_approvals_tenant_time_idx ON owner_approvals (tenant_id, approved_at DESC);

ALTER TABLE owner_approvals ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped read for the ledger MCP (hisab_app) inside confirm_* tools.
CREATE POLICY tenant_isolation ON owner_approvals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The orchestrator writes approvals in the inbound path and purges them on deletion.
CREATE POLICY orch_all ON owner_approvals TO hisab_orch USING (true) WITH CHECK (true);

GRANT SELECT ON owner_approvals TO hisab_app;
GRANT SELECT, INSERT, DELETE ON owner_approvals TO hisab_orch;
