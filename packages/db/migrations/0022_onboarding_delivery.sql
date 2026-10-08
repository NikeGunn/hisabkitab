-- 0022: track the delivery of every onboarding WhatsApp message.
--
-- Meta ACCEPTS a send synchronously and reports its fate later on the webhook
-- (2026-10-08: an approval code was accepted, then failed with 131042 "Business
-- eligibility payment issue", and the admin panel still said "sent"). Each
-- onboarding send (approval notice, verification code) is recorded here with
-- Meta's message id; the status webhook moves it forward; a failure Meta calls
-- temporary is retried automatically with backoff; a permanent one is parked and
-- shown in the admin panel with a manual Retry.
--
-- status        accepted → sent → delivered → read (monotonic), or failed
-- retry_at      when the retrier should try again (NULL = not scheduled)
-- superseded_at set once a newer attempt replaced this row (retried / paired)

CREATE TABLE onboarding_messages (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  to_e164        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('approval_notice', 'approval_code', 'admin_code', 'signup_code')),
  wa_message_id  TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'accepted'
                 CHECK (status IN ('accepted', 'sent', 'delivered', 'read', 'failed')),
  error_code     INTEGER,
  error_title    TEXT,
  attempt        INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  retry_at       TIMESTAMPTZ,
  superseded_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX onboarding_messages_tenant_idx ON onboarding_messages (tenant_id, id DESC);
CREATE INDEX onboarding_messages_retry_idx ON onboarding_messages (retry_at)
  WHERE retry_at IS NOT NULL AND superseded_at IS NULL;

ALTER TABLE onboarding_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY orch_all ON onboarding_messages TO hisab_orch USING (true) WITH CHECK (true);
-- DELETE: the GDPR purge (deleteTenantData) removes a business's rows
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_messages TO hisab_orch;
GRANT USAGE, SELECT ON SEQUENCE onboarding_messages_id_seq TO hisab_orch;
