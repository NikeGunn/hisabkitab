# HisabKitab — Incident Response & DR Runbook

_P15 (PRD v2.0 §9). A written runbook for the three incident classes that matter for a
financial system of record: a **security breach**, **data loss**, and a **wrong-filing
dispute** — plus backups, retention, and recovery targets._

> Single VM today; this runbook scales to managed Postgres + multiple replicas later. Keep it
> current as infra changes. Contacts are placeholders — fill in before go-live.

## 0. Roles & contacts
| Role | Who | Contact |
|---|---|---|
| Incident lead (on-call) | _TBD_ | _TBD_ |
| Database / infra owner | _TBD_ | _TBD_ |
| Communications (to affected owners) | _TBD_ | _TBD_ |
| Legal / compliance | _TBD_ | _TBD_ |

Severity: **SEV1** customer data exposed or money mis-moved · **SEV2** outage, no data loss ·
**SEV3** degraded / single-tenant issue.

## 1. Recovery targets (SLOs)
- **RPO (max data loss):** ≤ 15 minutes (Postgres WAL archiving / PITR).
- **RTO (max downtime):** ≤ 2 hours for SEV1/SEV2 restore-from-backup.
- **Financial invariant (never violated):** **0 silent double-writes**, **0 wrong figures sent**
  — the audit gate and idempotency layer protect these; a breach of either is automatically SEV1.

## 2. Backups & point-in-time recovery
- **Automated Postgres backups:** nightly base backup + continuous WAL archiving →
  encrypted off-host storage. Verify the last successful backup daily (alert if > 25h old).
- **Encryption:** backups encrypted at rest; the backup encryption key and
  `FIELD_ENCRYPTION_KEY` are in the secret manager, **never in the backup bundle**.
- **Retention:** daily for 30 days, weekly for 90 days (align with `docs/legal/DATA-PROCESSING.md`).
- **Restore drill (run quarterly):**
  1. Provision a scratch Postgres.
  2. Restore the latest base backup + replay WAL to a chosen timestamp (PITR).
  3. Run migrations check + `verify_audit_chain` on a sample tenant (must PASS).
  4. Boot the stack against the restored DB; hit `/healthz` on all 3 services.
  5. Record restore duration vs the 2h RTO. File a ticket if missed.

## 3. Playbook — Security breach (SEV1)
1. **Contain:** rotate ALL secrets immediately (`TENANT_SIGNING_SECRET`, `FIELD_ENCRYPTION_KEY`*,
   `ANTHROPIC_API_KEY`, `WA_*`, `KHALTI_*`, DB creds). Revoke leaked tokens/sessions.
   *Note: rotating the field key requires a re-encrypt migration (read with old key, write with
   new) — do NOT discard the old key until re-encryption is verified.*
2. **Assess scope:** which tenants, which data. PAN/VAT are field-encrypted, so a DB-only leak
   without the field key does not expose them — confirm whether the field key was also exposed.
3. **Preserve evidence:** snapshot logs + the hash-chained audit log (it proves what was/wasn't
   altered). Do not delete anything.
4. **Eradicate & recover:** patch the vector, restore from a known-clean backup if integrity is
   in doubt, re-deploy.
5. **Notify:** affected owners + any regulator as legally required, with what happened, what
   data, and what they should do. Comms owner drives this.
6. **Post-mortem** within 5 business days (blameless; action items tracked).

## 4. Playbook — Data loss / corruption (SEV1/2)
1. Stop writes to the affected store (put the orchestrator in maintenance / scale to 0 webhook).
2. Identify the last-good timestamp (before the corruption/deletion).
3. PITR-restore to that timestamp on a scratch DB; validate with `verify_audit_chain` + spot
   checks of recent confirmed entries.
4. Cut over (promote the restored DB or copy back the affected tenants). Communicate the RPO gap
   (what, if anything, was lost) to affected owners.
5. Re-enable writes; verify idempotency keys prevent duplicate replays of any queued webhooks.

## 5. Playbook — Wrong-filing dispute (SEV2/3)
An owner says a figure HisabKitab prepared was wrong / led to a penalty.
1. **Pull the record:** the tamper-evident audit log + validation events + the exact draft the
   owner confirmed and when. The product promise is "nothing saved/stated without confirmation"
   — establish what was shown vs confirmed vs filed.
2. **Reproduce** the computation deterministically (Money/VAT/TDS pure fns + the stored inputs).
3. **Classify:** input error (owner data) vs bug (engine) vs deadline misread.
   - Bug → fix + regression test + check other tenants for the same exposure; SEV escalates.
   - Input/deadline → show the owner the trail; HisabKitab does not file, the owner confirms.
4. **Document the outcome** and any goodwill resolution; feed lessons into validation probes.

## 6. Comms templates (fill in)
- Owner breach notice · status-page outage update · dispute acknowledgement. Keep them short,
  factual, and action-oriented. No speculation before facts are confirmed.

## 7. After every incident
- Update this runbook with what was missing.
- Add/adjust an automated alert so the next occurrence is caught earlier.
- Add a test/probe that would have caught it.
