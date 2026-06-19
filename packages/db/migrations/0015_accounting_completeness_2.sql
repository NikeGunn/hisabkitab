-- P13 accounting completeness (remainder, PRD v2.0 §12): TDS deposit reminder,
-- opening balances, and a backdated-entry flag. Forward-only + additive — existing
-- rows stay valid (new columns default false; the reminder_log CHECK only WIDENS).
-- Mirrors 0007/0014: money is BIGINT paisa, tenant-scoped + RLS, least-privilege grants.

-- ---------------------------------------------------------------- TDS deposit reminder
-- TDS withheld in a BS month is due by the 25th of the FOLLOWING month — the same
-- statutory cutoff as the VAT return (PRD v1.1 §5.2/§5.3). The scheduler sends a
-- proactive 'tds_due_soon' Utility nudge, latched exactly-once on the SAME
-- (tenant, bs_year, bs_month, kind) unique index as the VAT reminders. We only need
-- to widen the kind CHECK to admit the new value; the latch already distinguishes it.
ALTER TABLE reminder_log DROP CONSTRAINT IF EXISTS reminder_log_kind_check;
ALTER TABLE reminder_log
  ADD CONSTRAINT reminder_log_kind_check
  CHECK (kind IN ('return_prepared', 'vat_due_soon', 'tds_due_soon'));

-- ---------------------------------------------------------------- backdated-entry flag
-- The entry already lands in the BS month it OCCURRED in (occurred_on drives the return
-- recompute). is_backdated records that the occurrence month is EARLIER than the month it
-- was recorded — so a previously-prepared return for that period must be re-summarized.
-- It is an audit/review signal, not a money field. Default false ⇒ all existing rows are
-- "not backdated", unchanged behaviour.
ALTER TABLE sales    ADD COLUMN is_backdated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE expenses ADD COLUMN is_backdated BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- opening balances
-- When a business onboards mid-year it already has open debtors/creditors and possibly a
-- VAT credit carried forward. Opening balances seed those truthfully so the very first
-- statement/aging report is accurate (PRD v2.0 §12). Owner-asserted facts → draft→confirm
-- like every other entry, through the same Audit Gate. A receivable/payable opening names a
-- party (the debtor/creditor); a vat_credit opening does not. Figures validated by
-- @hisab/shared computeOpening before insert; the CHECKs here are the DB-level backstop.
CREATE TABLE opening_balances (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  kind        TEXT NOT NULL CHECK (kind IN ('receivable', 'payable', 'vat_credit')),
  -- party is REQUIRED for receivable/payable (a debtor/creditor) and NULL for vat_credit.
  party_id    UUID REFERENCES parties(id),
  amount_paisa BIGINT NOT NULL CHECK (amount_paisa > 0),
  as_of       DATE NOT NULL,
  fiscal_year INTEGER NOT NULL,                          -- BS fiscal year of as_of
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- party present iff a debtor/creditor opening; absent for vat_credit.
  CONSTRAINT opening_party_shape CHECK (
    (kind IN ('receivable', 'payable') AND party_id IS NOT NULL) OR
    (kind = 'vat_credit' AND party_id IS NULL)
  )
);

CREATE INDEX opening_balances_tenant_idx ON opening_balances (tenant_id, kind, status);
CREATE INDEX opening_balances_party_idx  ON opening_balances (tenant_id, party_id);

-- ---------------------------------------------------------------- Row-Level Security
ALTER TABLE opening_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON opening_balances
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------- least-privilege grants
-- app drafts/confirms opening balances (tenant-scoped via RLS); orch deletes them in the
-- GDPR purge (mirrors how orch purges the other tenant tables). No UPDATE except confirm.
GRANT SELECT, INSERT, UPDATE ON opening_balances TO hisab_app;
-- orch needs SELECT too: the GDPR purge's `DELETE … WHERE tenant_id = … RETURNING id`
-- reads those columns under RLS, so DELETE alone is insufficient (mirrors usage_counters).
GRANT SELECT, DELETE ON opening_balances TO hisab_orch;
DROP POLICY IF EXISTS orch_all ON opening_balances;
CREATE POLICY orch_all ON opening_balances TO hisab_orch USING (true) WITH CHECK (true);
