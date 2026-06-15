-- P9 idempotency, claim-first fix (PRD v2.0 §6).
--
-- The exactly-once guarantee under TRUE concurrency requires reserving the key
-- BEFORE producing the entry: insert a placeholder key row, then UPDATE it with the
-- producer's result once the entry is written. Two racing transactions then serialize
-- on the unique index — only the claim winner produces, so a second entry can never be
-- written (previously both could insert before either latched the key).
--
-- 0008 granted hisab_app only SELECT, INSERT (append-only). The finalize step needs
-- UPDATE on its OWN tenant's rows. RLS still scopes every row to the current tenant, so
-- this does not widen cross-tenant access — the app may only finalize keys it claimed.

GRANT UPDATE ON idempotency_keys TO hisab_app;
