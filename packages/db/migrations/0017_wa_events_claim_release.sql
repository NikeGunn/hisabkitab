-- 0017: crash containment for inbound messages (at-least-once, never silent loss).
--
-- The router claims a message FIRST (wa_events insert = dedupe gate), then
-- processes it. Meta is ACKed 200 before processing, so no webhook retry is
-- coming: if the pipeline crashes before anything reached the owner, the
-- orchestrator now RELEASES the claim (deletes the wa_events row) and asks the
-- owner to resend — mirroring the claim-first / delete-on-send-fail pattern the
-- schedulers already use on reminder_log.
--
-- hisab_orch had only SELECT, INSERT (0002); the release path needs DELETE.

GRANT DELETE ON wa_events TO hisab_orch;
