-- 0021: pilot applications are reviewed by the operator before any code is sent.
--
-- With `signup.require_approval` on (the default), the website form no longer sends
-- a WhatsApp verification code. It records an APPLICATION: a pending tenant with
-- review_status = 'awaiting' and the number the applicant CLAIMED. Nothing is
-- spent and nothing reaches the number until the operator presses Approve in the
-- admin panel, which notifies the applicant on WhatsApp. The number still becomes
-- the owner's identity only when a message arrives FROM it (Meta-verified sender).
--
-- review_status   NULL for businesses created before 0021 or by the admin directly
--                 (those never need a review). awaiting → approved | declined.
-- applicant_e164  the WhatsApp number typed on the form (unverified until paired).
-- reviewed_at     when the operator approved or declined.

ALTER TABLE tenants
  ADD COLUMN review_status  TEXT CHECK (review_status IN ('awaiting', 'approved', 'declined')),
  ADD COLUMN applicant_e164 TEXT,
  ADD COLUMN reviewed_at    TIMESTAMPTZ;

-- the signup + inbound lookups go by the claimed number of a still-pending business
CREATE INDEX tenants_applicant_idx ON tenants (applicant_e164) WHERE status = 'pending';
