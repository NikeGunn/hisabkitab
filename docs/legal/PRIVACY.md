# HisabKitab — Privacy Policy

_Last updated: 2026-06-16. Plain-language summary; not legal advice._

## What we collect
- **Business records you send us:** sales, expenses, bills/photos, vendor & customer names,
  PAN/VAT numbers, payments, and the messages you send over WhatsApp.
- **Identity:** the WhatsApp phone number(s) of the owner and any team members you invite, and
  each member's role.
- **Operational data:** message/event ids (for exactly-once processing), usage counts for
  billing/limits, and an audit log of actions taken.

We do **not** collect or store passwords, OTPs, or government-portal logins — these are refused
on arrival and never persisted.

## How we use it
Only to provide the service: record-keeping, VAT/TDS preparation, reports, reminders, billing,
support, abuse prevention, and meeting legal obligations. We do **not** sell your data or use
it for advertising.

## How it is protected
- **In transit:** TLS everywhere.
- **At rest:** the most sensitive PII (PAN/VAT numbers) is **field-level encrypted**
  (AES-256-GCM) in our database. Tenant data is isolated per business (Postgres Row-Level
  Security); access is role-checked server-side and deny-by-default.
- **Integrity:** the audit log is tamper-evident (hash-chained), so the record of what happened
  cannot be silently rewritten.
- **Secrets** are held in a secret manager, never in our code or logs.

## Who processes it
- **Anthropic (Claude / Managed Agents)** processes message content to power the assistant.
  Sessions are server-side and are deleted when you delete your data. See
  [DATA-PROCESSING.md](DATA-PROCESSING.md) for the sub-processor list and data location.
- **WhatsApp / Meta** delivers messages. **Khalti** processes subscription payments.

## Where it lives
Our database and processing run in the region documented in
[DATA-PROCESSING.md](DATA-PROCESSING.md).

## Retention & your rights
- We keep your data while your account is active and for a limited period after, then delete or
  anonymize it (see Data Processing notice for the retention window).
- **Right to deletion:** you can ask us to delete your business's data at any time. We purge
  every tenant-scoped record in our database and delete the assistant's sessions/files, and we
  keep only a data-free proof that the request was honored.
- You can ask what we hold about your business and request corrections.

## Contact
privacy@hisabkitab.pro · https://hisabkitab.pro
