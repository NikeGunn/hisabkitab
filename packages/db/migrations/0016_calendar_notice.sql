-- Compliance-calendar proactive notice (zero-hallucination calendar, core agent feature).
-- A once-per-BS-month consolidated "what's due" digest rides the existing daily scheduler
-- and is latched exactly-once on the SAME reminder_log (tenant, bs_year, bs_month, kind)
-- index as the VAT/TDS reminders. We only need to widen the kind CHECK to admit the new
-- value; the latch already distinguishes it. Forward-only + additive (the CHECK only WIDENS).

ALTER TABLE reminder_log DROP CONSTRAINT IF EXISTS reminder_log_kind_check;
ALTER TABLE reminder_log
  ADD CONSTRAINT reminder_log_kind_check
  CHECK (kind IN ('return_prepared', 'vat_due_soon', 'tds_due_soon', 'deadline_digest'));

-- The calendar digest pass runs as hisab_orch (cross-tenant, like the VAT/TDS reminders)
-- and must READ each tenant's open AR invoices / AP bills + party names to build the "what's
-- due" list. Grant orch READ-ONLY on those three tables (mirrors 0005's orch grant on
-- expenses/validation_events). Read-only — the digest never writes business data.
-- Idempotent (drop-if-exists) so a partial/re-run is safe.
DROP POLICY IF EXISTS orch_all ON ar_invoices;
CREATE POLICY orch_all ON ar_invoices TO hisab_orch USING (true) WITH CHECK (true);
GRANT SELECT ON ar_invoices TO hisab_orch;

DROP POLICY IF EXISTS orch_all ON ap_bills;
CREATE POLICY orch_all ON ap_bills TO hisab_orch USING (true) WITH CHECK (true);
GRANT SELECT ON ap_bills TO hisab_orch;

DROP POLICY IF EXISTS orch_all ON parties;
CREATE POLICY orch_all ON parties TO hisab_orch USING (true) WITH CHECK (true);
GRANT SELECT ON parties TO hisab_orch;
