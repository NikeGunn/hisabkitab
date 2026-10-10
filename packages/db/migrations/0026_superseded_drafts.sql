-- 0026: a correction replaces its own draft (Rehearsal Lab finding #4).
--
-- When the owner corrects a drafted bill ("no, it was 11,000"), the agent re-drafts.
-- The old draft stayed in the books as a draft, so the Validation Engine's duplicate
-- check flagged the corrected draft as a duplicate of the agent's OWN superseded
-- draft. record_sale / record_expense now take `supersedes_entry_id`: the old DRAFT
-- (never a confirmed entry — that needs a credit note) is marked 'superseded' in the
-- same transaction, excluded from duplicate checks, listings and every report.
-- Nothing is deleted (hisab_app has no DELETE on the books, by design).

ALTER TABLE sales DROP CONSTRAINT sales_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_status_check CHECK (status IN ('draft', 'confirmed', 'superseded'));
ALTER TABLE expenses DROP CONSTRAINT expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check CHECK (status IN ('draft', 'confirmed', 'superseded'));
