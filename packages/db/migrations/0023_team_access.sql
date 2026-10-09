-- 0023: team access management (auditor role, time-limited access, removal).
--
-- Lets an owner (over WhatsApp) or the operator (admin panel) give someone access
-- to a business's books, for a limited time if wanted, and take it away again.
--
--   role 'auditor'  strictly read-only: reports + audit-trail verification, never
--                   a write (enforced in @hisab/shared/rbac + every MCP tool).
--   expires_at      access ends at this instant (NULL = until removed). Checked
--                   on EVERY inbound message, so an expired member is denied on
--                   their very next message without any background job.
--   granted_via     who granted it: 'chat' (owner command) | 'admin' (operator) |
--                   'system' (pairing / backfill). Audit + owner transparency.
--   revoked_at/_via when and by whom access was removed; the row is KEPT (history),
--                   status 'revoked' frees the seat and blocks the number.

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('owner', 'accountant', 'auditor', 'staff', 'viewer'));

ALTER TABLE memberships
  ADD COLUMN expires_at  TIMESTAMPTZ,
  ADD COLUMN granted_via TEXT NOT NULL DEFAULT 'system'
             CHECK (granted_via IN ('chat', 'admin', 'system')),
  ADD COLUMN revoked_at  TIMESTAMPTZ,
  ADD COLUMN revoked_via TEXT CHECK (revoked_via IN ('chat', 'admin', 'system'));

-- The owner can never be given an end date (no accidental self-lockout).
ALTER TABLE memberships ADD CONSTRAINT memberships_owner_never_expires
  CHECK (role <> 'owner' OR expires_at IS NULL);
-- A revoked row always says when; a live row never carries a revocation.
ALTER TABLE memberships ADD CONSTRAINT memberships_revoked_shape
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL));
