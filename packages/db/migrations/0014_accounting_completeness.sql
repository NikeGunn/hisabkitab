-- P13 accounting completeness (PRD v2.0 §12): gap-free sequential VAT invoice
-- numbering + credit/debit notes. A confirmed invoice is IMMUTABLE; returns and
-- corrections are issued as linked notes (proper accounting + intact audit trail).
-- Mirrors 0007 (arap): money is BIGINT paisa, every table tenant-scoped + RLS,
-- least-privilege grants. Note math is validated in @hisab/shared (computeNote)
-- before insert; the CHECKs here are the DB-level backstop.

-- ---------------------------------------------------------------- invoice numbering
-- IRD Rule-17 requires gap-free sequential numbers PER fiscal year. last_number is
-- bumped under SELECT … FOR UPDATE in the allocating tx so concurrent allocations
-- serialize (no reuse, no gap). One row per (tenant, fiscal_year); resets each FY.
CREATE TABLE invoice_sequences (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  fiscal_year INTEGER NOT NULL,                       -- BS fiscal year (start year)
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (tenant_id, fiscal_year)
);

-- ---------------------------------------------------------------- credit/debit notes
CREATE TABLE credit_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  original_invoice_id UUID NOT NULL REFERENCES ar_invoices(id),
  kind                TEXT NOT NULL CHECK (kind IN ('credit', 'debit')),
  note_no             TEXT,
  issued_on           DATE NOT NULL,
  taxable_paisa       BIGINT NOT NULL CHECK (taxable_paisa >= 0),
  vat_paisa           BIGINT NOT NULL CHECK (vat_paisa >= 0),
  total_paisa         BIGINT NOT NULL CHECK (total_paisa > 0),
  reason              TEXT,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX credit_notes_invoice_idx ON credit_notes (tenant_id, original_invoice_id);

-- ---------------------------------------------------------------- Row-Level Security
ALTER TABLE invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes      ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_sequences
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON credit_notes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------- least-privilege grants
-- app allocates numbers (INSERT/UPDATE the sequence) and drafts/confirms notes.
-- Same access shape as the 0007 arap tables (app-only, tenant-scoped via RLS); the
-- cross-tenant orch purge of AR/AP-family tables is handled separately when wired.
GRANT SELECT, INSERT, UPDATE ON invoice_sequences TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON credit_notes      TO hisab_app;
