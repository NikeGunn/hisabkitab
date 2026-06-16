# HisabKitab — Data Processing Notice

_Last updated: 2026-06-16. Companion to the [Privacy Policy](PRIVACY.md)._

This notice documents how and where HisabKitab processes your business data, and the
third parties ("sub-processors") involved.

## Roles
- **You (the business owner)** are the controller of your business records.
- **HisabKitab** is the processor acting on your instructions to keep records and prepare
  figures.

## Categories of data processed
| Category | Examples | Sensitivity |
|---|---|---|
| Financial records | sales, expenses, bills, invoices, payments | confidential |
| PII | PAN/VAT numbers, business name, phone numbers | **PAN/VAT field-encrypted at rest** |
| Identity & access | owner/team WhatsApp numbers, roles | confidential |
| Operational | message ids, usage counters, audit log | internal |

## Sub-processors
| Sub-processor | Purpose | Data shared |
|---|---|---|
| Anthropic (Claude / Managed Agents) | powers the assistant; reads message content to extract/answer | message content, bill images, the figures under discussion |
| Meta / WhatsApp Business Platform | message delivery | message content, phone numbers |
| Khalti | subscription payment processing | plan, amount, payment ids (no card data held by us) |
| Cloud host (single VM / managed Postgres + Redis) | runs the app & stores data | all stored data (encrypted in transit; PAN/VAT encrypted at rest) |

> Update this table with the concrete provider names + regions before going live. The
> deployment region is recorded in [DEPLOY.md](../DEPLOY.md).

## Data location
- **Primary store:** PostgreSQL in the region documented in `DEPLOY.md`.
- **Assistant processing:** Anthropic Managed Agents (server-side sessions; not ZDR-eligible,
  so sessions are explicitly deleted on a deletion request).

## Security measures (summary)
TLS in transit · AES-256-GCM field encryption for PAN/VAT at rest · Postgres Row-Level Security
for tenant isolation · server-side RBAC, deny-by-default · tamper-evident hash-chained audit log
· secrets in a secret manager · credential inputs (passwords/OTPs) refused and never stored.

## Retention
- Active account: retained for service.
- After account closure: deleted or anonymized within **90 days** unless a longer period is
  legally required (e.g. tax record-keeping obligations on the owner's side, which the owner
  controls via their own exported copies).
- Backups: encrypted; rotated out within the backup retention window in `DEPLOY.md`.

## Right to deletion
On request, we run the deletion flow: purge all tenant-scoped Postgres rows + delete the
assistant's sessions/files, retaining only a data-free proof (counts/ids) that the request was
honored. See `packages/orchestrator/src/security/data-deletion.ts`.

## Contact
privacy@hisabkitab.pro
