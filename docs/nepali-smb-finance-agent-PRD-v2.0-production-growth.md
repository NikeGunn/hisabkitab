# PRD v2.0 — Production, Growth & Platform (the "sellable SaaS" layer)

**Version:** 2.0 (extends v1.0/v1.1/v1.2) · **Owner:** Nikhil · **Build:** Claude Code · **Lang:** TypeScript
**Status:** Build **after** the v1 pilot validates retention.

> **Read this first — version boundary & sequencing.**
> v1.0–v1.2 = the **MVP** you pilot with 5–10 cafés (record → verify → remind → report).
> **v2.0 = the commercialization layer** that turns the MVP into a FAANG-grade product you can sell at
> scale: billing, multi-user, voice, reliability, security, growth. **Do not build v2.0 before the
> pilot proves people keep using v1.** Overbuilding pre-PMF is the #1 way solo founders die. Each v2
> section below notes whether it's *required for first paid customer* or *scale-time*. Build only the
> "first paid customer" set to start charging; defer the rest until volume demands it.
> All v1 invariants still hold: never guess, confirm before save, Pre-delivery Audit Gate, money as
> paisa, tenant isolation via RLS, prepare-don't-file.

---

## 1. Plans & monetization  *(required for first paid customer)*

Suggested tiers (a hypothesis to test in the pilot, not gospel — you set final prices):

| Plan | Price/mo (NPR) | Who | Includes |
|---|---|---|---|
| **Free trial** | 0 for 14–30 days | everyone | Full Pro features, time-limited, to drive activation |
| **Starter** | ~999 | solo micro-shop | Logging (text/photo/voice), VAT reminders, nil-return prep, 1 user |
| **Pro** | ~1,999 | growing SMB | + AR/AP, debtor/creditor tracking, statements, 3 users |
| **Business** | ~2,999–3,000 | established SMB | + all PDF reports, flexible analytics, accountant seat, priority support |
| **Accountant** | custom (per-client) | accounting firms | Manage many client businesses from one login (see §4) |

Design plans as **config** (a `plans` table / config file), gate features by plan in the orchestrator,
and surface "upgrade to unlock" prompts (e.g. owner asks for a report on Starter → agent offers upgrade).

---

## 2. Billing & subscription system  *(required for first paid customer)*

- **Collection in NPR:** use **Khalti** (already integrated) for recurring subscription collection, plus
  bank transfer/QR for annual prepay. (Nepali gateways lack true card-on-file auto-debit, so model
  subscriptions as **prepaid periods**: owner pays for a month/quarter/year; you don't silently auto-charge.)
- **Lifecycle:** trial → active → past_due (grace) → suspended → cancelled. Grace period (e.g. 7 days)
  before suspension; suspended tenants keep read access to their data + a pay-to-reactivate prompt.
- **Dunning:** on expiry, WhatsApp Utility reminder ("your subscription ends in 3 days — tap to renew")
  + in-chat renewal link. Never delete data on non-payment; suspend and retain.
- **Billing artifacts:** issue the owner a proper receipt/invoice for *their* subscription payment
  (you are also a Nepali business — your own VAT applies once you cross the threshold).
- **Idempotent payment handling:** subscription webhooks use the §6 idempotency layer (never double-credit).
- **Admin overrides:** comp/extend/refund a tenant from the admin console (§13).

---

## 3. Identity, multi-user, roles & permissions  *(required for first paid customer)*

Today: one phone = one tenant. Real businesses need several people. Introduce **users** and **memberships**.

- A **user** = one WhatsApp number (verified identity).
- A **membership** links a user to a tenant with a **role**. One user can belong to multiple tenants
  (enables §4). Each inbound message resolves `(user, active_tenant) → role` before anything runs.

**Roles & permissions matrix:**

| Capability | Owner | Accountant | Staff | Viewer |
|---|---|---|---|---|
| Record entries (draft) | ✅ | ✅ | ✅ | ❌ |
| Confirm entries (save) | ✅ | ✅ | ❌ | ❌ |
| Generate reports | ✅ | ✅ | ❌ | ✅ |
| Prepare/mark VAT return | ✅ | ✅ | ❌ | ❌ |
| Initiate/refund payment | ✅ | ❌ | ❌ | ❌ |
| Manage users/billing | ✅ | ❌ | ❌ | ❌ |
| See all financial data | ✅ | ✅ | limited | ✅ |

- **Invite flow:** owner texts "add my accountant 98XXXXXXXX as accountant" → system sends that number a
  pairing invite → on accept, membership created. All in WhatsApp, no app.
- The role is enforced **server-side** in the MCP tools (not just the prompt) and reflected in RLS context.
- This is also what makes the "**cross-check your accountant**" pitch real: the accountant gets a Viewer/
  Accountant seat and pulls the same verified reports.

---

## 4. Multi-business & the accountant channel  *(scale-time, but huge growth lever)*

- One user (esp. an accountant) manages **many tenants**. Add a "switch business" command ("show
  Sharma Traders") and default-tenant logic. Each session still scoped to exactly one tenant.
- **The accountant channel is your cheapest growth:** one accountant onboards 20–50 client businesses.
  Build an **Accountant plan** (per-client pricing) and a simple multi-client view. This single feature
  can outperform all consumer marketing — prioritize it once the core is stable.

---

## 5. Voice notes & multilingual  *(voice = required-ish; it's your catchiest feature)*

- **Voice notes (Nepali/Romanized/English):** owner sends a WhatsApp voice note ("aja ko sales pachalis
  hajar") → download audio → transcribe (speech-to-text) → run the **same** extraction/confirmation
  protocol → echo back text + ask to confirm. **Never act on a voice note without echoing the
  transcription for confirmation** (transcription error = wrong money). This is the killer feature for
  low-literacy owners and directly reuses your SANU experience.
- **STT options:** evaluate a Nepali-capable model; if accuracy is weak, transcribe + confirm aggressively
  and let the owner correct. Treat low-confidence transcription exactly like a blurry bill.
- **Multilingual replies:** detect the owner's language per message; reply in kind (Devanagari, Romanized,
  or English). Localize numbers/dates (BS dates, NPR formatting). Optional voice replies later.

---

## 6. Idempotency, concurrency & exactly-once  *(required — correctness, non-negotiable)*

This is a **finance** product; double-recording money is unacceptable.

- **Inbound dedupe:** WhatsApp delivers webhooks at-least-once. Store each WhatsApp `message.id` in an
  `idempotency_keys` table; ignore duplicates. Same for Khalti/subscription callbacks (by `pidx`/event id).
- **Idempotent writes:** every entry-creating MCP tool accepts a client-supplied `idempotency_key`;
  a repeat with the same key returns the original result, never a second row.
- **Per-tenant serialization:** process one owner's messages in order (per-tenant queue / advisory lock)
  so two near-simultaneous messages can't create a race on the same invoice balance.
- **Exactly-once allocation:** payment→invoice allocation runs in a single DB transaction with row locks;
  reject over-allocation; never partially apply.
- **Gateway reconciliation:** a periodic job reconciles your `sales(source=gateway)` against Khalti's
  lookup API to catch missed/duplicated callbacks.

---

## 7. Cost controls, model routing & abuse prevention  *(required for first paid customer)*

Protects your unit economics (the Rs 3,000 margin) and stops abuse.

- **Per-tenant budgets:** monthly token + Managed Agents runtime cap per plan; soft-warn then throttle.
  Alert you on anomalies (a tenant suddenly 10× normal usage).
- **Model routing:** classify intent cheaply; use a smaller/faster model for trivial turns ("ok", "thanks",
  simple logging) and reserve Opus-class for extraction, tax reasoning, and report prep. Big cost saver.
- **Rate limits:** cap messages/images per minute/day per tenant; large-image downscaling before vision;
  reject absurd payloads. Backpressure instead of unbounded queues.
- **Caching:** cache vendor lookups, BS-date conversions, IRD-deadline fetches (per day) to cut tokens/calls.
- **Spend dashboard:** track cost-per-tenant vs revenue-per-tenant; this is your make-or-break metric.

---

## 8. Observability & SRE  *(scale-time; add health checks + structured logs from day 1)*

- **Structured logging** (JSON) with a `correlation_id` threaded WhatsApp msg → session → MCP call → DB.
- **Metrics:** message latency, agent turn latency, extraction-confirm rate, audit-gate hold rate,
  report reconcile-fail rate, gateway success rate, per-tenant cost, queue depth, error rates.
- **Tracing:** spans across orchestrator → Managed Agents → MCP servers (Managed Agents already traces;
  correlate yours to it).
- **Alerting & SLOs:** define SLOs (e.g. 99% of messages answered < 10s for simple turns; 0 financial
  double-writes; report reconcile-fail → page). Alert on breaches.
- **Reliability primitives:** retries with backoff + jitter; **dead-letter queue** for failed jobs;
  **circuit breakers** around Khalti/WhatsApp/Anthropic; graceful degradation (if a gateway is down,
  queue and inform the owner, don't lose data); idempotent retries (§6).
- **Health checks** + readiness/liveness for each deployable. Synthetic canary that runs the
  record→confirm→report path nightly.

---

## 9. Security & compliance  *(required subset for first paid customer; full set at scale)*

- **Encryption:** TLS everywhere; encryption at rest for DB and file storage; field-level encryption for
  the most sensitive PII (PAN/VAT numbers).
- **Secrets:** central secret manager + **rotation**; least-privilege credentials per service; no secret
  in repo/prompt/logs (already enforced).
- **Audit-log immutability:** append-only + periodic **hash-chaining** (each row references prior row's
  hash) so tampering is detectable — important for a financial system of record.
- **AuthZ:** role checks enforced server-side (§3); RLS everywhere; deny-by-default.
- **Data residency & retention:** document where tenant data lives (your DB region + Managed Agents
  processing). Retention + **right-to-deletion** flow (delete tenant data + Managed Agents sessions/files).
  Backups encrypted; define retention.
- **Backups & DR:** automated Postgres backups + **point-in-time recovery**; tested restore runbook;
  RPO/RTO targets; a written **incident-response runbook** (breach, data loss, wrong-filing dispute).
- **Legal:** Terms of Service, Privacy Policy, and a Data Processing notice — with the **"assistance, not
  a substitute for a licensed auditor / not statutory sign-off"** disclaimer surfaced at signup and in
  report footers. Capture consent at onboarding. (Get these reviewed by a Nepali lawyer before charging.)
- **Threat model:** run a STRIDE pass; protect the WhatsApp webhook (signature verify — already in v1),
  add WAF/rate-limit/bot protection; plan a pen-test before scaling.
- **Abuse/fraud:** detect a single number trying to claim multiple businesses' data; phone re-verification
  for sensitive role/billing changes.

---

## 10. Infra, environments & CI/CD  *(required subset for first paid customer)*

- **Deployables need public HTTPS** reachable by Managed Agents (the MCP servers) and Meta (the webhook).
- **Containerize** (Docker) all three services; **IaC** (Terraform) for reproducible infra.
- **Environments:** dev / staging / prod with separate DBs, secrets, WhatsApp numbers, and Khalti keys.
- **CI:** on every PR — `tsc --strict`, eslint, `vitest` (incl. the §verification probes), dependency/secret
  scan, build. **CD:** deploy on green; **zero-downtime, forward-only DB migrations** (expand/contract
  pattern); canary or blue-green for the orchestrator.
- **SBOM + dependency pinning;** Renovate/Dependabot for security updates.

---

## 11. Growth, activation & virality  *(the "users love it & pay" engine — pick 2–3 to start)*

**Activation funnel** (instrument every step): signup → pair → **first entry within 5 min** → first
confirmed save → first report → first filing cycle → habit (logs ≥ 3×/week). Optimize the first-entry moment.

**Viral / growth loops:**
- **Referral:** "invite another shop — you both get a free month." Track via `referrals`.
- **Accountant channel (§4)** — the strongest loop; one accountant = many businesses.
- **Branded shareable report:** the monthly PDF carries a tasteful "Prepared with <Product>" footer +
  link; owners who forward statements to customers/banks spread it for free.

**Retention / delight (these make them *love* it):**
- **Daily/weekly digest** (opt-in Utility template): "Yesterday: Rs 28,400 across 41 sales. Top item: momo.
  VAT so far this month: Rs 12,300."
- **Proactive insights:** "Sharma is 45 days overdue (Rs 9,040) — want me to draft a polite reminder?"
- **One-tap debtor reminder:** agent drafts a courteous "you owe Rs X" message the owner forwards to the
  customer — turns your app into a cash-collection tool (owners adore this).
- **Generate & send VAT invoice:** owner makes a sale → agent produces a proper sequential Rule-17 invoice
  PDF to send the customer.
- **Deadline peace-of-mind:** the 25th reminder is itself a retention engine; add TDS-deposit reminders.
- **Festival/seasonal awareness;** gentle "logging streak" nudges (never guilt-trippy).

**Landing page (honest hero):** lead with *"Your pocket accountant on WhatsApp — log a bill by photo or
voice, get VAT-ready in seconds. You approve every entry; it never guesses."* Pricing page with the tiers
above; a "for accountants" page for the channel. **Avoid** any "zero mistakes" claim (see v1.1 §1A).

---

## 12. Accounting completeness  *(fold into Ledger MCP as you grow)*

Real bookkeeping needs these — missing today:
- **Sequential VAT invoice numbering:** IRD requires gap-free sequential invoice numbers per fiscal year.
  Generate and enforce sequence per tenant; never reuse/skip; store the series.
- **Credit notes / debit notes:** for sales returns, cancellations, and corrections — don't edit a
  confirmed invoice's amount; issue a linked credit/debit note (proper accounting + audit trail).
- **Void/adjust with audit, never delete:** confirmed entries are immutable; corrections are reversing
  entries that reference the original. Preserves the audit chain.
- **Fiscal year (Shrawan–Ashar):** year boundary handling, annual summary, carry-forward of VAT credit
  across the year, reset invoice sequences appropriately.
- **Opening balances:** when a business onboards mid-year, let them enter existing open debtors/creditors
  and a VAT-credit carry-forward (via confirmed opening entries) so reports are accurate from day one.
- **Backdated entries:** allowed with the BS-period correctly assigned + a flag; recompute affected return.
- **TDS deposit reminder:** TDS is also due by the 25th — add it alongside the VAT reminder.

---

## 13. Support & internal admin console  *(required subset for first paid customer)*

- **Human escalation:** "talk to a human" routes to you/support (ticket + WhatsApp handoff). Never let the
  agent pretend to be human.
- **Admin/ops console (internal web app):** list tenants, subscription/health/cost status, audit-log
  viewer, manual correction tools (with their own audit trail), comp/extend/refund billing, impersonate-
  for-support (with consent + logging). This is how you actually run the business day to day.
- **Status page** + a way to notify tenants of incidents.

---

## 14. Data import / onboarding assist  *(scale-time)*

- CSV/Excel import for existing customers, suppliers, and open balances (validated through the same
  confirmation + reconciliation gates) so an onboarding business isn't starting from empty.
- Guided first-week onboarding flow in chat (record your first sale, your first bill, generate your first
  report) to drive activation.

---

## 15. Data model additions (v2.0)

Extends prior schema; money `bigint` paisa; `tenant_id` + RLS throughout.

```sql
CREATE TABLE users (              -- a verified WhatsApp identity
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_e164 TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (        -- user ↔ tenant with a role
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL,             -- owner|accountant|staff|viewer
  status TEXT NOT NULL DEFAULT 'active',  -- invited|active|revoked
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE plans (              -- config, feature flags as JSONB
  code TEXT PRIMARY KEY, name TEXT, price_paisa BIGINT, features JSONB
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  status TEXT NOT NULL,           -- trial|active|past_due|suspended|cancelled
  current_period_end DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_payments (   -- the tenant paying YOU
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  amount_paisa BIGINT NOT NULL, gateway TEXT, gateway_ref TEXT,
  period_start DATE, period_end DATE,
  status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (   -- inbound + write dedupe
  key TEXT PRIMARY KEY,           -- whatsapp msg id / pidx / client key
  tenant_id UUID, scope TEXT,
  result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invoice_sequences (  -- sequential Rule-17 numbering
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  fiscal_year INTEGER NOT NULL,   -- BS year
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, fiscal_year)
);

CREATE TABLE credit_notes (       -- returns/corrections (never edit confirmed invoices)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  original_invoice_id UUID, note_no TEXT, issued_on DATE,
  taxable_paisa BIGINT, vat_paisa BIGINT, total_paisa BIGINT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_tenant UUID, referred_tenant UUID, status TEXT, reward_applied BOOLEAN DEFAULT false
);

CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID, user_id UUID, subject TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
```

Add `audit_log` hash-chain columns: `prev_hash TEXT, row_hash TEXT`.

---

## 16. Build phases (append to the v1 sequence)

Group v2 into a **"Commercialization track"**; build the *required-for-first-paid-customer* subset before
charging, defer the rest.

- **P8 — Identity & RBAC:** users, memberships, roles enforced server-side + RLS; invite flow. *(required)*
- **P9 — Idempotency & concurrency:** dedupe table, idempotent write keys, per-tenant serialization,
  allocation transactions. *(required — do this early; it's correctness)*
- **P10 — Billing:** plans config, subscriptions, Khalti recurring/prepaid, trial→active→suspend lifecycle,
  dunning reminders, feature-gating. *(required)*
- **P11 — Cost controls:** per-tenant budgets, model routing, rate limits, image downscaling, spend metrics.
  *(required)*
- **P12 — Voice & multilingual:** voice-note transcription → confirmation reuse; language detect/reply.
- **P13 — Accounting completeness:** sequential invoice numbers, credit/debit notes, fiscal year, void/adjust,
  opening balances, TDS reminder.
- **P14 — Observability & reliability:** structured logs + correlation id, metrics, alerting/SLOs, DLQ,
  circuit breakers, health checks, nightly canary.
- **P15 — Security & compliance:** encryption at rest, secret rotation, audit hash-chaining, backups/PITR,
  retention/deletion, ToS/Privacy + consent, threat-model pass.
- **P16 — Infra & CI/CD:** Docker, Terraform, dev/staging/prod, CI (typecheck/lint/test/scan), CD,
  zero-downtime migrations.
- **P17 — Growth:** activation instrumentation, referral, daily digest, one-tap debtor reminder,
  generate-and-send invoice, branded report footer, landing/pricing pages.
- **P18 — Support & admin console:** human escalation, internal ops/admin web app, status page.
- **P19 — Accountant channel & data import:** multi-business switch, Accountant plan, CSV import.

---

## 17. Acceptance criteria & SLOs (v2.0)
- A retried WhatsApp/payment webhook **never** creates a second entry (idempotency test with replays).
- Two simultaneous messages from one owner can't corrupt an invoice balance (concurrency test).
- A Staff user cannot confirm entries or move money; an Accountant can read + report; RLS blocks cross-tenant.
- A tenant can subscribe via Khalti, hit past_due, get a dunning reminder, and reactivate — data retained throughout.
- Per-tenant cost is tracked and a runaway tenant is throttled + alerted.
- A voice note is transcribed, **echoed for confirmation**, and never acted on un-confirmed.
- Sequential invoice numbers are gap-free per fiscal year; a return is handled by a credit note, not an edit.
- Audit log is hash-chained and tamper-evident; a tested restore meets the RPO/RTO target.
- Activation, retention, referral, and cost-per-tenant are all instrumented and visible.
- 0 financial double-writes is a hard SLO; report reconcile-fail pages on-call.

## 18. Metrics to watch (product + business)
Activation rate (paired → first entry), week-1 / month-1 retention, logs/week per active tenant,
trial→paid conversion, churn, MRR, **cost-per-tenant vs revenue-per-tenant** (the survival metric),
audit-gate hold rate, extraction-confirm success, report reconcile-fail rate, NPS, referral coefficient.

## 19. Honest caveats & sequencing
- **Don't build all of v2 now.** Pilot v1 → prove retention → build the "required-for-first-paid-customer"
  subset (P8–P11, minimal P15/P16) → charge → then scale the rest with demand. Sequence beats completeness.
- Nepali recurring billing is prepaid-period, not silent auto-debit — design for that reality.
- Voice STT accuracy in Nepali is the main unknown; confirmation-first contains the risk but test early.
- Get ToS/Privacy and the auditor-disclaimer reviewed by a Nepali lawyer before taking money.
- Keep the human filing the government return; keep the process-guarantee (never "zero mistakes").
