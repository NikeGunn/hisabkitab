-- Module C-1 (PRD v1.2 §C2): Accounts Receivable / Payable data layer.
-- parties unifies customers & suppliers (extends v1.1 `vendors`; vendors stays for
-- the expense-flow PAN memory). Money is BIGINT paisa; every table is tenant-scoped + RLS.
-- balance_paisa is decremented by allocations inside ONE locked tx; CHECK (balance >= 0)
-- is the DB-level backstop for the allocation logic in @hisab/shared.

CREATE TABLE parties (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  name              TEXT NOT NULL,
  pan_vat_no        TEXT,
  is_vat_registered BOOLEAN,
  kind              TEXT NOT NULL DEFAULT 'both' CHECK (kind IN ('customer', 'supplier', 'both')),
  phone             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE ar_invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  party_id      UUID NOT NULL REFERENCES parties(id),
  invoice_no    TEXT,
  issued_on     DATE NOT NULL,
  due_on        DATE,
  taxable_paisa BIGINT NOT NULL CHECK (taxable_paisa >= 0),
  vat_paisa     BIGINT NOT NULL CHECK (vat_paisa >= 0),
  total_paisa   BIGINT NOT NULL CHECK (total_paisa >= 0),
  balance_paisa BIGINT NOT NULL CHECK (balance_paisa >= 0 AND balance_paisa <= total_paisa),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ap_bills (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  party_id              UUID NOT NULL REFERENCES parties(id),
  bill_no               TEXT,
  billed_on             DATE NOT NULL,
  due_on                DATE,
  taxable_paisa         BIGINT NOT NULL CHECK (taxable_paisa >= 0),
  vat_paisa             BIGINT NOT NULL CHECK (vat_paisa >= 0),
  total_paisa           BIGINT NOT NULL CHECK (total_paisa >= 0),
  balance_paisa         BIGINT NOT NULL CHECK (balance_paisa >= 0 AND balance_paisa <= total_paisa),
  input_credit_eligible BOOLEAN NOT NULL DEFAULT false,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE party_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  party_id     UUID NOT NULL REFERENCES parties(id),
  direction    TEXT NOT NULL CHECK (direction IN ('received', 'paid')),
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0),
  paid_on      DATE NOT NULL,
  method       TEXT CHECK (method IN ('cash', 'khalti', 'esewa', 'bank')),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_allocations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  payment_id   UUID NOT NULL REFERENCES party_payments(id),
  target_type  TEXT NOT NULL CHECK (target_type IN ('ar_invoice', 'ap_bill')),
  target_id    UUID NOT NULL,
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0)
);

-- Query-path indexes: party lookup by name, open-balance scans for aging/statements,
-- and allocation lookups by payment/target.
CREATE INDEX ar_invoices_party_idx        ON ar_invoices (tenant_id, party_id, status);
CREATE INDEX ar_invoices_open_idx         ON ar_invoices (tenant_id, status, due_on) WHERE balance_paisa > 0;
CREATE INDEX ap_bills_party_idx           ON ap_bills (tenant_id, party_id, status);
CREATE INDEX ap_bills_open_idx            ON ap_bills (tenant_id, status, due_on) WHERE balance_paisa > 0;
CREATE INDEX party_payments_party_idx     ON party_payments (tenant_id, party_id, paid_on);
CREATE INDEX payment_allocations_pay_idx  ON payment_allocations (tenant_id, payment_id);
CREATE INDEX payment_allocations_tgt_idx  ON payment_allocations (tenant_id, target_type, target_id);

-- ---------------------------------------------------------------- Row-Level Security
-- Same fail-closed pattern as 0001: app.tenant_id from signed session metadata only.
ALTER TABLE parties             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_bills            ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_payments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON parties
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON ar_invoices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON ap_bills
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON party_payments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON payment_allocations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------- least-privilege grants
GRANT SELECT, INSERT, UPDATE ON parties             TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON ar_invoices         TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON ap_bills            TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON party_payments      TO hisab_app;
-- allocations are immutable once written (corrections are new payments): no UPDATE.
GRANT SELECT, INSERT         ON payment_allocations  TO hisab_app;
