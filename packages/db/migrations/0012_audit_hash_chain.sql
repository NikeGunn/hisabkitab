-- Tamper-evident audit-log hash-chain (PRD v2.0 §9; CLAUDE.md §3).
--
-- audit_log is the financial system of record. Append-only grants stop the app
-- from editing rows, but hash-chaining makes ANY tamper (edit/insert/delete/
-- reorder) detectable: each row carries its own hash and the previous row's hash,
-- per tenant. A pure re-walk (verifyAuditChain) proves the chain.
--
--   row_hash = SHA-256( prev_hash || '\n' || canonical(row) )    -- computed in app
--   prev_hash = the previous row's row_hash for the SAME tenant  -- genesis = 64×'0'
--
-- Columns are nullable so existing pre-chain rows remain valid; every NEW row is
-- written chained. Appends for one tenant serialize via a per-tenant advisory lock
-- in the app (see audit-chain.ts), so concurrent writes can't fork the chain.

ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN row_hash  TEXT;

-- Fast lookup of a tenant's chain tip (latest row) when appending + verifying.
CREATE INDEX audit_log_tenant_id_idx ON audit_log (tenant_id, id);
