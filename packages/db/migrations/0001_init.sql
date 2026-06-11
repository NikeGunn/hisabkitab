-- HisabKitab v1.1 schema (PRD v1.0 §4 merged with v1.1 §8).
-- Money columns are BIGINT paisa. Every tenant table carries tenant_id + RLS.
-- The app connects as `hisab_app` (NOSUPERUSER, NOBYPASSRLS) so policies are enforced;
-- migrations and tenant provisioning run on the admin connection.

CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name   TEXT NOT NULL,
  pan_or_vat_no   TEXT NOT NULL,
  vat_registered  BOOLEAN NOT NULL DEFAULT true,
  whatsapp_e164   TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pairing_codes (
  code        TEXT PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE vendors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  name              TEXT NOT NULL,
  pan_vat_no        TEXT,
  is_vat_registered BOOLEAN,
  UNIQUE (tenant_id, name)
);

CREATE TABLE sales (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  occurred_on           DATE NOT NULL,
  description           TEXT,
  amount_excl_vat_paisa BIGINT NOT NULL CHECK (amount_excl_vat_paisa >= 0),
  vat_paisa             BIGINT NOT NULL CHECK (vat_paisa >= 0),
  payment_method        TEXT CHECK (payment_method IN ('cash', 'esewa', 'khalti', 'bank')),
  source                TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'gateway')),
  gateway_ref           TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  occurred_on              DATE NOT NULL,
  vendor_name              TEXT,
  vendor_is_vat_registered BOOLEAN NOT NULL DEFAULT false,
  category                 TEXT,
  amount_excl_vat_paisa    BIGINT NOT NULL CHECK (amount_excl_vat_paisa >= 0),
  -- vat_paisa = VAT printed on the bill; input_vat_paisa = the CLAIMABLE portion
  -- (0 when ineligible: non-VAT vendor, 17Ka, >1yr, non-business use). Kept separate so
  -- totals always reconcile (excl + vat = bill total) even when credit is denied.
  vat_paisa                BIGINT NOT NULL DEFAULT 0 CHECK (vat_paisa >= 0),
  input_vat_paisa          BIGINT NOT NULL DEFAULT 0 CHECK (input_vat_paisa >= 0),
  tds_rate_bps             INTEGER NOT NULL DEFAULT 0 CHECK (tds_rate_bps >= 0),
  tds_paisa                BIGINT NOT NULL DEFAULT 0 CHECK (tds_paisa >= 0),
  receipt_file_id          TEXT,
  invoice_no               TEXT,
  invoice_type             TEXT CHECK (invoice_type IN ('rule17', 'rule17ka', 'other')),
  input_credit_eligible    BOOLEAN NOT NULL DEFAULT false,
  extraction               JSONB,
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vat_returns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  bs_year           INTEGER NOT NULL,
  bs_month          INTEGER NOT NULL CHECK (bs_month BETWEEN 1 AND 12),
  output_vat_paisa  BIGINT NOT NULL,
  input_vat_paisa   BIGINT NOT NULL,
  net_payable_paisa BIGINT NOT NULL,
  carry_forward_paisa BIGINT NOT NULL DEFAULT 0,
  is_nil            BOOLEAN NOT NULL,
  status            TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'confirmed_filed_by_user')),
  summary_file_id   TEXT,
  prepared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bs_year, bs_month)
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  actor      TEXT NOT NULL CHECK (actor IN ('agent', 'owner', 'system')),
  action     TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE validation_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  entry_type TEXT,
  entry_id   UUID,
  result     TEXT NOT NULL CHECK (result IN ('pass', 'warn', 'fail')),
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Query-path indexes: every hot query is (tenant, status, month-range) or a duplicate probe.
CREATE INDEX sales_tenant_status_date_idx    ON sales (tenant_id, status, occurred_on);
CREATE INDEX expenses_tenant_status_date_idx ON expenses (tenant_id, status, occurred_on);
CREATE INDEX expenses_dup_invoice_idx        ON expenses (tenant_id, lower(vendor_name), lower(invoice_no));
CREATE INDEX expenses_dup_amount_idx         ON expenses (tenant_id, occurred_on, amount_excl_vat_paisa);
CREATE INDEX sales_dup_amount_idx            ON sales (tenant_id, occurred_on, amount_excl_vat_paisa);
CREATE INDEX audit_log_tenant_time_idx       ON audit_log (tenant_id, created_at);
CREATE INDEX validation_events_entry_idx     ON validation_events (tenant_id, entry_type, entry_id);

-- ---------------------------------------------------------------- Row-Level Security
-- app.tenant_id is set per-transaction via set_config(..., true) from SIGNED session
-- metadata, never from tool arguments. current_setting(..., true) returns NULL when
-- unset, NULLIF guards '' — both fail CLOSED (no rows) rather than erroring open.

ALTER TABLE tenants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales             ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE vat_returns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_self ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON pairing_codes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON vendors
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON sales
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON expenses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON vat_returns
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON validation_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------- least-privilege grants
GRANT USAGE ON SCHEMA public TO hisab_app;
GRANT SELECT                         ON tenants            TO hisab_app;
GRANT SELECT, INSERT, UPDATE         ON pairing_codes      TO hisab_app;
GRANT SELECT, INSERT, UPDATE         ON vendors            TO hisab_app;
GRANT SELECT, INSERT, UPDATE         ON sales              TO hisab_app;
GRANT SELECT, INSERT, UPDATE         ON expenses           TO hisab_app;
GRANT SELECT, INSERT, UPDATE         ON vat_returns        TO hisab_app;
-- audit_log and validation_events are APPEND-ONLY for the app: no UPDATE, no DELETE.
GRANT SELECT, INSERT                 ON audit_log          TO hisab_app;
GRANT SELECT, INSERT                 ON validation_events  TO hisab_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hisab_app;
