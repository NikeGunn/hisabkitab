-- 0020: an undelivered signup code must not count against the owner's limits.
--
-- Before: when Meta refused the pairing_code template (e.g. #131030 "recipient not
-- in allowed list" while the sender is a test number), the code was burned but its
-- row still counted toward the per-number (3/24h) limit and the global daily cap,
-- so three failed tries locked a real owner out for a day with a misleading "too
-- many attempts". Meta does not bill a refused message, so there is no spend to
-- protect; the per-IP bucket still caps abuse.
--
-- send_failed_at  set when the template send failed. The row stays (it ties the
--                 pending business to the number, so a retry reuses it instead of
--                 creating an orphan) but is excluded from both limits.

ALTER TABLE pairing_codes
  ADD COLUMN send_failed_at TIMESTAMPTZ;

-- Backfill: rows burned within seconds of creation and never consumed are the
-- send failures (a resend-revoke needs a whole second form submission, and
-- misclassifying one only loosens the limit by one code).
UPDATE pairing_codes
   SET send_failed_at = expires_at
 WHERE phone_e164 IS NOT NULL
   AND consumed_at IS NULL
   AND expires_at < created_at + interval '20 seconds';
