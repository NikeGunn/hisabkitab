-- 0019: runtime settings + admin audit + self-serve signup + notification outbox.
--
-- app_settings      operator-editable config (WhatsApp sender, Khalti key/mode,
--                   signup controls). Secrets are AES-256-GCM ciphertext
--                   (enc:v1:… via FIELD_ENCRYPTION_KEY), never plaintext in prod.
--                   Effective value = this table → env → registry default
--                   (@hisab/shared/settings), so a fresh deploy is unchanged.
-- admin_events      append-only log of every admin action (login, setting change,
--                   tenant setup). Secrets are never written here, only "changed".
-- tenants.*         signup metadata (owner name, email, source).
-- pairing_codes.*   a signup code is BOUND to the number it was sent to and burns
--                   after too many wrong attempts.
-- outbound_notifications  transactional WhatsApp template outbox. Written in the
--                   SAME transaction as the business event (e.g. a settled Khalti
--                   payment) so a receipt is queued exactly once; the orchestrator
--                   drains it (claim → send → mark).
--
-- These are orchestrator-plane tables (hisab_orch). hisab_app (the tenant-
-- scoped MCP runtime) gets NO grant: it can never read the Khalti or Meta secrets.

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  is_secret   BOOLEAN NOT NULL DEFAULT false,
  updated_by  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_events (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_events_created_idx ON admin_events (created_at DESC);

ALTER TABLE tenants
  ADD COLUMN owner_name     TEXT,
  ADD COLUMN contact_email  TEXT,
  ADD COLUMN signup_source  TEXT NOT NULL DEFAULT 'admin'
             CHECK (signup_source IN ('admin', 'web'));

ALTER TABLE pairing_codes
  ADD COLUMN phone_e164      TEXT,
  ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN created_at      TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX pairing_codes_phone_idx ON pairing_codes (phone_e164, created_at);

CREATE TABLE outbound_notifications (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID REFERENCES tenants(id),
  to_e164       TEXT NOT NULL,
  template      TEXT NOT NULL,
  body_params   JSONB NOT NULL DEFAULT '[]'::jsonb,
  button_param  TEXT,
  -- latch: one notification per (kind, business event), e.g. 'payment_received:<pidx>'
  dedupe_key    TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);
CREATE INDEX outbound_notifications_pending_idx ON outbound_notifications (status, created_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------- RLS (fail closed)
ALTER TABLE app_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY orch_all ON app_settings           TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON admin_events           TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON outbound_notifications TO hisab_orch USING (true) WITH CHECK (true);

-- The payments MCP settles a subscription inside the TENANT's transaction
-- (hisab_app, verify_subscription) and must queue the receipt atomically with it:
-- hisab_app may insert/read outbox rows for ITS OWN tenant only.
CREATE POLICY tenant_isolation ON outbound_notifications TO hisab_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON outbound_notifications TO hisab_app;
GRANT USAGE, SELECT ON SEQUENCE outbound_notifications_id_seq TO hisab_app;

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE, DELETE ON app_settings   TO hisab_orch; -- DELETE = "Reset to default"
GRANT SELECT, INSERT         ON admin_events           TO hisab_orch;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_notifications TO hisab_orch;
-- signup: a pending tenant whose code expired can be re-issued; codes are purged
-- on deletion (already covered by the GDPR purge of pairing_codes).
GRANT DELETE ON pairing_codes TO hisab_orch;
-- GDPR purge (deleteTenantData) must remove billing rows too; 0009 only granted S/I/U,
-- so deleting any business that ever had a trial/subscription failed.
GRANT DELETE ON subscriptions, billing_payments TO hisab_orch;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hisab_orch;
