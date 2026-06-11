# PRD — Nepali SMB Finance Agent ("ledger-on-WhatsApp")

**Version:** 1.0 (v1 build spec)
**Owner:** Nikhil
**Build tool:** Claude Code
**Primary language:** TypeScript (Node.js 20+)
**Runtime for the agent:** Claude Managed Agents (Anthropic-hosted harness, beta)
**Status:** Ready to implement

---

## 0. One-paragraph summary

A WhatsApp-first bookkeeping and tax assistant for small VAT-registered businesses in Nepal. A café owner records sales and expenses by texting a single WhatsApp number (photo of a bill, a voice note, or "add catering 9000"). The agent keeps the ledger, computes VAT (13%) and TDS, nudges the owner before the monthly IRD deadline (25th of the following Nepali month), and **prepares** the VAT return and a Rule-17 invoice for the owner to file and pay herself via the IRD portal / ConnectIPS. The agent never auto-files to the government and never touches money without an explicit in-thread confirmation.

---

## 1. Scope & explicit decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Data model | **Model A — agent is the system of record** | Public Nepali payment APIs are collection gateways, not "read my whole wallet" APIs. The agent owns the ledger; collected payments auto-import via your merchant integration. |
| IRD filing | **Prepare, do not auto-file** | No public IRD filing API; automating a government portal is fragile + ToS risk. Liability stays with the owner. |
| WhatsApp model | **One central WhatsApp Business number; identify tenant by sender phone + one-time pairing** | Zero setup for non-technical owners. They save one number and text it. |
| Language | **TypeScript** | I/O-bound workload, first-class Anthropic Agent SDK + MCP support, one stack end-to-end, type safety for money math. |
| Money representation | **Integer paisa (bigint), never floats** | Financial correctness. 1 NPR = 100 paisa. |
| Agent runtime | **Claude Managed Agents** | Anthropic hosts the agent loop, sandbox, context mgmt, tracing. You build MCP servers + WhatsApp + DB. |

**Out of scope for v1:** auto-filing to IRD, reading owners' existing bank/wallet statements via API, income-tax annual return, payroll, multi-currency, a customer-facing storefront, voice calling.

---

## 2. High-level architecture

```
                         ┌─────────────────────────────┐
   Café owner (Sita)     │   WhatsApp (Meta Cloud API)  │
   on WhatsApp  ───────► │   ONE central business number │
                         └──────────────┬──────────────┘
                                        │ webhook (HTTPS/JSON)
                                        ▼
                       ┌──────────────────────────────────┐
                       │  Orchestrator service (TypeScript)│
                       │  - WhatsApp webhook + sender→tenant│
                       │  - pairing / onboarding            │
                       │  - reminder scheduler (the 25th)   │
                       │  - creates Managed Agent sessions  │
                       └───────┬───────────────────┬───────┘
                               │                   │
              create session   │                   │  send/stream events
                (per tenant)   ▼                   ▼
                  ┌────────────────────────────────────────┐
                  │      CLAUDE MANAGED AGENTS (Anthropic)   │
                  │  agent loop · sandbox · context · trace  │
                  │  built-in tools: bash, files, web        │
                  └───────┬───────────────────────┬─────────┘
                          │ MCP connector         │ MCP connector
                          ▼                       ▼
              ┌────────────────────┐   ┌────────────────────────┐
              │  Ledger MCP server │   │  Payments MCP server     │
              │  (TypeScript)      │   │  (TypeScript)            │
              │  wraps Postgres    │   │  wraps Khalti + eSewa    │
              └─────────┬──────────┘   └────────────┬───────────┘
                        │                           │
                        ▼                           ▼
                ┌──────────────┐          Khalti KPG / eSewa ePay v2
                │  PostgreSQL  │          (merchant APIs, your keys)
                │ multi-tenant │
                └──────────────┘
```

You build three TypeScript deployables: **(1) Orchestrator service**, **(2) Ledger MCP server**, **(3) Payments MCP server**. Anthropic hosts the agent itself.

---

## 3. Tech stack

- **Language:** TypeScript, Node.js 20+, ESM.
- **Web framework:** Fastify (orchestrator + webhook). Lightweight, fast, great TS types.
- **MCP servers:** `@modelcontextprotocol/sdk` (TypeScript), exposed as **remote MCP servers** (HTTP/SSE) so Managed Agents can connect via the MCP connector.
- **Agent control:** `@anthropic-ai/sdk` with the `managed-agents-2026-04-01` beta header (or the Agent SDK where convenient).
- **DB:** PostgreSQL 16. Access via `drizzle-orm` (typed schema + migrations) or `kysely`. Use **Row-Level Security (RLS)** for tenant isolation.
- **Money:** store `bigint` paisa. For any non-trivial arithmetic use `decimal.js`; never JS `number` for money.
- **Validation:** `zod` for every external input (webhook payloads, MCP tool args).
- **Queue/scheduler:** `BullMQ` + Redis for the monthly reminder jobs and retry.
- **Secrets:** Managed Agents **vaults** for Khalti/eSewa keys passed to the agent; orchestrator's own secrets in your host's secret manager (never in code/repo).
- **Testing:** `vitest`. Contract tests against Khalti/eSewa sandbox.
- **Lint/format:** `eslint` + `prettier`, `tsc --strict`.

---

## 4. Data model (PostgreSQL)

All money columns are `bigint` paisa. All business data carries `tenant_id`. Enable RLS so a session can only see its own tenant.

```sql
-- tenants = the businesses
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name   TEXT NOT NULL,
  pan_or_vat_no   TEXT NOT NULL,              -- 9-digit IRD number
  vat_registered  BOOLEAN NOT NULL DEFAULT true,
  whatsapp_e164   TEXT UNIQUE,                -- bound after pairing
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|active|suspended
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one-time pairing codes for onboarding
CREATE TABLE pairing_codes (
  code            TEXT PRIMARY KEY,           -- e.g. "4821"
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ
);

-- sales the owner records
CREATE TABLE sales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  occurred_on     DATE NOT NULL,
  description     TEXT,
  amount_excl_vat_paisa  BIGINT NOT NULL,
  vat_paisa       BIGINT NOT NULL,            -- 13% of excl
  payment_method  TEXT,                       -- cash|esewa|khalti|bank
  source          TEXT NOT NULL DEFAULT 'manual', -- manual|gateway
  gateway_ref     TEXT,                       -- pidx / transaction_uuid
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- purchases / expenses (give input VAT credit)
CREATE TABLE expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  occurred_on     DATE NOT NULL,
  vendor_name     TEXT,
  vendor_is_vat_registered BOOLEAN NOT NULL DEFAULT false,
  category        TEXT,                       -- goods|service|rent|...
  amount_excl_vat_paisa BIGINT NOT NULL,
  input_vat_paisa BIGINT NOT NULL DEFAULT 0,  -- claimable only if vendor VAT-registered + valid bill
  tds_rate_bps    INTEGER NOT NULL DEFAULT 0, -- 150 = 1.5%, 1500 = 15%
  tds_paisa       BIGINT NOT NULL DEFAULT 0,
  receipt_file_id TEXT,                        -- Managed Agents file id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- a prepared VAT return for a Nepali month
CREATE TABLE vat_returns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  bs_year         INTEGER NOT NULL,           -- e.g. 2083
  bs_month        INTEGER NOT NULL,           -- 1..12 (Baisakh..Chaitra)
  output_vat_paisa BIGINT NOT NULL,
  input_vat_paisa  BIGINT NOT NULL,
  net_payable_paisa BIGINT NOT NULL,          -- max(output-input, 0); negative => credit carryforward
  is_nil          BOOLEAN NOT NULL,
  status          TEXT NOT NULL DEFAULT 'prepared', -- prepared|confirmed_filed_by_user
  summary_file_id TEXT,
  prepared_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bs_year, bs_month)
);

-- append-only audit of every agent action
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  actor       TEXT NOT NULL,                  -- agent|owner|system
  action      TEXT NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**RLS:** every query runs with `SET app.tenant_id = '<uuid>'`; policies restrict each table to `tenant_id = current_setting('app.tenant_id')::uuid`. The MCP server sets this per request from the validated session tenant.

---

## 5. Nepal tax rules the agent must encode

These live in the Skill file (Section 8). Source them at build time and let the agent re-check current deadlines via web fetch.

- **VAT rate:** flat **13%** on standard taxable supplies.
- **Filing cadence:** monthly, due by the **25th of the following Nepali (BS) month** via the IRD portal (ird.gov.np / taxpayerportal.ird.gov.np).
- **Nil returns are mandatory** even with zero transactions.
- **Input VAT credit:** claimable only on purchases from VAT-registered vendors with a valid VAT bill.
- **TDS on service payments:** **1.5%** if the recipient is VAT-registered; **15%** if the recipient has only a PAN (no VAT). TDS is computed on the taxable amount **excluding VAT**.
- **Registration thresholds (context only):** mandatory VAT registration above NPR 50 lakh turnover (goods) / NPR 30 lakh (services/mixed).
- **Payment:** owner generates a voucher on the IRD portal and pays via ConnectIPS or bank e-payment.
- **BS calendar:** the app must convert Gregorian dates to Bikram Sambat months for return periods and deadlines. Use a maintained BS<->AD library (e.g. `nepali-date-converter`); pin the version and unit-test month boundaries.

> Treat all tax constants as **config**, not hardcoded literals scattered in code, so a rate or deadline change is a one-line update. The agent should also `web_fetch` the IRD calendar to confirm the current month's deadline before sending a reminder.

---

## 6. The Claude Managed Agent definition

Created once via the Managed Agents API, referenced by ID per session.

```jsonc
{
  "model": "claude-opus-4-8",            // reasoning quality matters for money; downshift to a smaller model only after eval
  "system_prompt": "<see Section 7>",
  "tools": [
    "bash",                                // build PDFs, parse files
    "file_operations",                     // read receipt images, write return summary
    "web_search", "web_fetch"              // confirm current IRD deadlines/rules
  ],
  "mcp_servers": [
    { "name": "ledger",   "url": "https://ledger.yourdomain.com/mcp",   "auth": "vault:ledger_token" },
    { "name": "payments", "url": "https://payments.yourdomain.com/mcp", "auth": "vault:payments_token" }
  ],
  "skills": ["nepal-vat-tds"],
  "beta_header": "managed-agents-2026-04-01"
}
```

- **Environment:** Anthropic-managed cloud sandbox for v1 (no compliance need for self-hosting yet). Each tenant interaction is its own **session**; the session is scoped to one `tenant_id` (passed as session metadata and enforced by the MCP servers).
- **Vaults:** Khalti/eSewa keys and the MCP server tokens are stored in Managed Agents vaults and injected at runtime — never in the system prompt, never logged.
- **Outcomes / self-verification:** see Section 11.

---

## 7. System prompt (full text)

```
You are "<ProductName>", a bookkeeping and tax assistant for a single small business
in Nepal. You speak the language the owner uses (Nepali, English, or Romanized
Nepali) and keep replies short, warm, and plain. You are NOT a general chatbot;
you only help with this business's bookkeeping, VAT, and TDS. Politely decline
unrelated requests.

You serve exactly ONE business per session. Never reference or reveal data about
any other business. The business's tenant context is provided to your tools; do
not ask the owner to prove who they are mid-conversation.

CORE BEHAVIORS
- When the owner sends a bill photo, extract vendor, date, amount, and VAT, then
  call ledger.record_expense. Confirm back in one short message.
- When the owner reports a sale ("catering 9000", "today's sales 28400"), call
  ledger.record_sale. Assume amounts are VAT-INCLUSIVE unless told otherwise, and
  say which assumption you used.
- Apply Nepal tax rules from your skill: 13% VAT; input VAT credit only for
  VAT-registered vendors with valid bills; TDS 1.5% (vendor VAT-registered) or 15%
  (PAN-only) on service payments, computed on the amount excluding VAT.
- Around the 20th of each Nepali month, you will be asked to prepare the monthly
  VAT return. Call ledger.generate_return_summary, present sales, output VAT,
  input VAT, and net payable in ONE screen, and ask the owner to review.
- File NIL returns when there are no transactions — remind the owner this is still
  required.

HARD RULES (never break)
- You PREPARE the VAT return; you NEVER file it with the government and you NEVER
  log into any government or bank portal. Tell the owner the exact numbers and let
  them file and pay via the IRD portal / ConnectIPS themselves.
- Never take any money action (initiate/refund a payment) without an explicit
  "✅" or "yes" from the owner in this chat.
- Never ask for, store, or accept passwords, OTPs, or IRD login credentials.
- If the owner edits a figure, recompute everything and show the corrected totals
  before they confirm.
- If you are unsure about a current deadline or rule, web_fetch the IRD calendar to
  confirm before stating it. If still unsure, say so plainly.

STYLE
- One screen max per message. No spreadsheets dumped into chat.
- Always show your VAT/TDS assumption so the owner can correct it.
- Money in NPR with thousands separators.
```

---

## 8. Skill: `nepal-vat-tds` (SKILL.md content)

```markdown
---
name: nepal-vat-tds
description: Nepal VAT and TDS rules for SMB bookkeeping. Use whenever computing VAT,
  input credits, TDS on payments, or preparing a monthly VAT return for a Nepali business.
---

# Nepal VAT & TDS rules (config-driven)

## VAT
- Standard rate: 13% on taxable supplies.
- Output VAT = sales (excl VAT) * 0.13.
- A VAT-inclusive amount X has: excl = round(X / 1.13), vat = X - excl. Use integer
  paisa arithmetic; round half-up to the nearest paisa.
- Input VAT credit: only on purchases from VAT-registered vendors with a valid VAT
  bill. No bill or non-registered vendor => input credit = 0.
- Net VAT payable for the month = max(output VAT - input VAT, 0). If negative, the
  excess is a credit carried forward (record it; do not pay negative).

## Filing
- Monthly. Due by the 25th day of the FOLLOWING Bikram Sambat month, via IRD portal.
- NIL return is mandatory even with zero transactions.
- Confirm the exact current deadline against the IRD calendar before reminding.

## TDS on service payments
- Recipient is VAT-registered: 1.5%.
- Recipient has only a PAN (no VAT): 15%.
- TDS base = amount EXCLUDING VAT.
- TDS is the payer's obligation; surface it but never auto-deduct without confirmation.

## Invoice (sales)
- Issue in the Rule-17 prescribed format: seller name + PAN/VAT no, buyer details,
  invoice no + date (BS), description, taxable amount, 13% VAT, total.

## Do NOT
- File returns with the government.
- Compute income tax / annual return (out of scope v1).
```

---

## 9. MCP Server 1 — Ledger (`ledger` service)

Remote MCP server (TypeScript, `@modelcontextprotocol/sdk`, HTTP/SSE transport). Wraps Postgres. **Every tool requires a validated `tenant_id`** (from session auth → sets RLS). All amounts are paisa.

Tools:

```ts
// record_sale
{ description: "Record a sale. Treat amount as VAT-inclusive unless inclusive=false.",
  input: { occurred_on: string /*ISO date*/, description?: string,
           amount_paisa: number, inclusive: boolean /*default true*/,
           payment_method?: "cash"|"esewa"|"khalti"|"bank" },
  output: { sale_id: string, amount_excl_vat_paisa: number, vat_paisa: number } }

// record_expense
{ description: "Record a purchase/expense and compute input VAT + TDS.",
  input: { occurred_on: string, vendor_name?: string,
           vendor_is_vat_registered: boolean, category?: string,
           amount_paisa: number, inclusive: boolean,
           is_service: boolean, receipt_file_id?: string },
  output: { expense_id: string, input_vat_paisa: number,
            tds_rate_bps: number, tds_paisa: number } }

// compute_vat  (pure helper, no write)
{ input: { amount_paisa: number, inclusive: boolean },
  output: { excl_paisa: number, vat_paisa: number } }

// generate_return_summary
{ description: "Compute the VAT return for a BS month (does NOT file).",
  input: { bs_year: number, bs_month: number },
  output: { output_vat_paisa: number, input_vat_paisa: number,
            net_payable_paisa: number, is_nil: boolean, sale_count: number,
            expense_count: number, return_id: string } }

// generate_rule17_invoice
{ input: { sale_id: string },
  output: { invoice_file_id: string } }   // writes a PDF into the sandbox/Files API

// list_transactions  (for "show me")
{ input: { bs_year: number, bs_month: number, type?: "sale"|"expense" },
  output: { items: Array<{ id, occurred_on, description, amount_paisa, kind }> } }

// mark_return_filed_by_user
{ description: "Owner confirmed they filed it themselves on IRD.",
  input: { return_id: string },
  output: { ok: true } }
```

Implementation notes:
- Validate every input with `zod`. Reject negative/oversized amounts.
- Wrap writes in a transaction; write an `audit_log` row for each.
- Rounding: half-up to nearest paisa, computed in integer math.
- The server authenticates the caller via a bearer token (from the agent vault) AND derives `tenant_id` from signed session metadata — do not trust a `tenant_id` passed in tool args.

---

## 10. MCP Server 2 — Payments (`payments` service)

Remote MCP server wrapping Khalti KPG (v2, `pidx`) and eSewa ePay (v2, HMAC-SHA256). Keys live in vault; sandbox keys for dev. This server handles **collection** (money INTO the merchant account) only.

Tools:

```ts
// initiate_payment  (create a pay link for a customer to pay the business)
{ input: { gateway: "khalti"|"esewa", amount_paisa: number,
           purpose: string, customer_ref?: string },
  output: { payment_url: string, payment_ref: string } } // pidx or transaction_uuid

// verify_payment
{ input: { gateway: "khalti"|"esewa", payment_ref: string },
  output: { status: "completed"|"pending"|"failed", amount_paisa: number } }

// refund_payment   (Khalti supports programmatic refund by pidx)
{ input: { gateway: "khalti", payment_ref: string, amount_paisa?: number },
  output: { ok: boolean } }

// list_collected_payments   (from YOUR DB of gateway callbacks, not the wallet)
{ input: { bs_year: number, bs_month: number },
  output: { items: Array<{ payment_ref, gateway, amount_paisa, paid_at }> } }
```

Implementation notes:
- eSewa: `product_code` differs sandbox (`EPAYTEST`) vs prod (your merchant code) — make it an **env var**, not a constant. Verify the HMAC signature on every callback.
- Khalti: use v2 endpoints; identify by `pidx`; verify via the lookup endpoint server-side before trusting any "paid" claim.
- A separate **callback webhook** (in the orchestrator or this service) receives gateway callbacks, verifies them, writes a `sales` row with `source='gateway'`, and links `gateway_ref`. This is how collected payments auto-import into the ledger.
- **Confirmation gate:** `initiate_payment` and `refund_payment` are only ever called after the orchestrator has seen an explicit owner "✅" for that specific action.

---

## 11. Session outcomes & self-verification

For return-preparation sessions, define a success criterion the agent self-checks before asking the owner to confirm:

```
SUCCESS when:
  generate_return_summary.net_payable_paisa
    == max(sum(sales.vat) - sum(claimable input_vat), 0) for the period
  AND every transaction the owner mentioned this session is recorded
  AND is_nil is true IFF sale_count == 0 AND expense_count == 0
```

If the check fails, the agent re-reads the ledger and recomputes rather than presenting numbers. A human "✅" is still required before `mark_return_filed_by_user` and before any payment action — self-verification reduces error, it does not replace consent.

---

## 12. WhatsApp service (orchestrator)

### 12.1 Inbound
- Single Meta **Cloud API** number. Webhook receives messages, verifies the `X-Hub-Signature-256`, looks up `tenant` by `whatsapp_e164 = sender`.
- If sender is unknown → treat as onboarding (Section 13).
- If known + active → start/continue a Managed Agents **session** for that tenant, forward the message (and any media → Files API) as a session event, stream the agent's reply back as a free-form WhatsApp message (free, inside the 24h service window).

### 12.2 Outbound (proactive — the deadline nudge)
- Business-initiated messages outside the 24h window **must use a pre-approved Utility template** (Meta prohibits open/general-purpose bots and charges per template; utility is cheap and free if inside an open window).
- Pre-build and submit for approval (do this early — approval takes time):
  - `vat_due_soon` (Utility): "Your VAT return for {{month}} is due on {{date}}. Reply to review the numbers."
  - `return_prepared` (Utility): "Your {{month}} VAT return is ready: net payable Rs {{amount}}. Reply 'show' to review."
  - `pairing_code` (Authentication or onboarding utility): used during signup if you send the code.
- Rate by **recipient country code** (Nepal). Never send marketing templates.

### 12.3 Messaging compliance
- Register the number's use case as a **defined-purpose finance assistant**, not a general chatbot.
- A fresh number starts with a daily messaging limit that scales with quality rating — fine for launch; monitor it.

---

## 13. Onboarding & pairing flow (non-technical, super simple)

1. **Signup** (you or a one-page form): capture `business_name`, `pan_or_vat_no`, `whatsapp_e164`, `vat_registered`. Create a `tenants` row (`status='pending'`) and a `pairing_codes` row (short code, 15-min expiry).
2. **Give the owner two things:** your WhatsApp number and the code (e.g. "START 4821").
3. **Owner sends** `START 4821` to your number from her phone. Webhook: unknown sender + body matches an unconsumed, unexpired code → bind `whatsapp_e164` to that tenant, set `status='active'`, consume the code, write `audit_log`.
4. **Confirmation reply:** "You're all set, {{business_name}}! Send me a photo of any bill, or tell me today's sales."
5. From then on she just chats. Nothing installed, nothing configured.

**Security of pairing:** binding requires possession of *both* the code (given out-of-band) and control of the WhatsApp number (WhatsApp verifies numbers). A stray number texting random text never matches and is ignored/onboarding-prompted.

---

## 14. Security model

- **Tenant isolation:** `tenant_id` on every row + Postgres RLS; MCP servers derive tenant from signed session metadata, never from tool args. One session = one tenant.
- **Secrets:** gateway keys + MCP tokens in Managed Agents **vaults**; orchestrator secrets in host secret manager; nothing in the repo or system prompt.
- **Consent gates:** every money/file-with-government-relevant action needs explicit in-thread "✅".
- **No credentials over chat:** the agent refuses to accept passwords/OTPs/IRD logins (enforced in system prompt + a guard that scrubs/aborts if a message looks like a credential).
- **Transport:** WhatsApp passes through Meta — treat it as non-confidential for secrets; financial figures are fine, login secrets are not.
- **Audit:** append-only `audit_log` + Managed Agents execution tracing = full reconstructable history for disputes.
- **Data rights:** Managed Agents sessions are stateful and not ZDR/HIPAA-eligible; you can delete sessions and uploaded files via the API. Add a tenant "delete my data" path.
- **Least privilege:** Payments server can collect/refund but cannot read the ledger; Ledger server cannot move money. Compromise of one is contained.

---

## 15. Repository structure

```
nepali-finance-agent/
├─ packages/
│  ├─ orchestrator/        # Fastify: WhatsApp webhook, pairing, scheduler, session mgmt
│  │  ├─ src/whatsapp/     #   inbound webhook + outbound templates
│  │  ├─ src/onboarding/   #   pairing
│  │  ├─ src/agent/        #   Managed Agents session client (beta header)
│  │  ├─ src/scheduler/    #   BullMQ jobs: monthly reminders
│  │  └─ src/gateway-callbacks/
│  ├─ mcp-ledger/          # Ledger MCP server (Postgres)
│  ├─ mcp-payments/        # Payments MCP server (Khalti + eSewa)
│  └─ shared/              # zod schemas, money utils (paisa), BS-date utils, types
├─ db/
│  ├─ schema.ts            # drizzle schema
│  └─ migrations/
├─ skills/
│  └─ nepal-vat-tds/SKILL.md
├─ agent/
│  └─ agent-definition.json
├─ .env.example
└─ README.md
```

Use a monorepo (pnpm workspaces). `shared` holds the money/paisa helpers and BS-date conversion so all three deployables compute identically.

---

## 16. Build sequence for Claude Code (phased — implement in order)

**Phase 0 — Foundations**
1. Init pnpm monorepo, strict TS, eslint/prettier, vitest. Create `shared` with: `Money` (paisa) helpers, VAT/TDS pure functions (with tests for rounding edge cases), BS↔AD date utils (with month-boundary tests).
2. Postgres + drizzle schema + RLS policies + migrations. Seed a test tenant.

**Phase 1 — Ledger MCP server**
3. Implement `compute_vat`, `record_sale`, `record_expense`, `generate_return_summary`, `list_transactions`, `mark_return_filed_by_user`, `generate_rule17_invoice`. Zod-validate all inputs. Audit-log all writes. Unit + contract tests. Deploy as remote MCP (HTTP/SSE) with bearer auth.

**Phase 2 — Agent wiring**
4. Write `agent-definition.json` and the `nepal-vat-tds` skill. Create the agent via the Managed Agents API (beta header). Write the orchestrator's session client: create session per tenant, send events, stream responses. Manually test end-to-end in the Console first.

**Phase 3 — WhatsApp**
5. Meta Cloud API setup (you do this once): business verification, number, webhook. Implement inbound webhook (signature verify → sender→tenant → session). Implement media → Files API. Implement outbound free-form replies.
6. Onboarding/pairing flow + the `pairing_code` path. Submit the three Utility templates for Meta approval **now** (long lead time).

**Phase 4 — Payments**
7. Payments MCP server against **sandbox** keys (Khalti v2 `pidx`, eSewa `EPAYTEST`/HMAC). Gateway callback webhook → write `sales(source='gateway')`. Confirmation-gate the write tools.

**Phase 5 — Proactive + verification**
8. BullMQ scheduler: on ~20th BS each month, for each active tenant, web-fetch/confirm deadline, run `generate_return_summary`, send `vat_due_soon`/`return_prepared` template. Wire the session outcome self-check (Section 11).

**Phase 6 — Hardening & pilot**
9. Credential-scrubbing guard, data-deletion endpoint, rate-limit handling, error/retry. Pilot with 5–10 cafés you know personally, VAT-only, one city. Watch the audit log on every filing cycle.

---

## 17. Environment variables (`.env.example`)

```
# Anthropic
ANTHROPIC_API_KEY=
MANAGED_AGENTS_BETA=managed-agents-2026-04-01
AGENT_ID=

# Postgres
DATABASE_URL=

# Redis (BullMQ)
REDIS_URL=

# WhatsApp Cloud API
WA_PHONE_NUMBER_ID=
WA_BUSINESS_ACCOUNT_ID=
WA_ACCESS_TOKEN=
WA_WEBHOOK_VERIFY_TOKEN=
WA_APP_SECRET=

# Khalti (sandbox first)
KHALTI_BASE_URL=https://a.khalti.com/api/v2
KHALTI_SECRET_KEY=

# eSewa (sandbox first)
ESEWA_BASE_URL=https://rc-epay.esewa.com.np
ESEWA_PRODUCT_CODE=EPAYTEST
ESEWA_SECRET=

# MCP server auth
LEDGER_MCP_TOKEN=
PAYMENTS_MCP_TOKEN=

# Tax config (overridable)
VAT_RATE_BPS=1300
TDS_SERVICE_VAT_REGISTERED_BPS=150
TDS_SERVICE_PAN_ONLY_BPS=1500
```

---

## 18. Acceptance criteria for v1

- An owner can pair in one message and record a sale/expense by text or photo.
- VAT and TDS compute correctly (covered by unit tests, including VAT-inclusive rounding and the 1.5% vs 15% TDS branch).
- The monthly summary reconciles exactly to the ledger; nil months are detected.
- A Utility reminder reaches the owner before the 25th (BS) deadline.
- No money action and no "filed" status change ever occurs without an in-thread "✅".
- The agent refuses credentials and refuses to file with the government.
- A second tenant's data is provably invisible to the first (RLS test).

---

## 19. Known risks / honest caveats

- **Bill OCR accuracy:** receipt photos vary; always echo extracted figures for confirmation. Don't trust extraction silently.
- **BS calendar correctness:** pin and test the date library; off-by-one months break deadlines.
- **Gateway sandbox→prod drift:** eSewa product_code and key swaps are the #1 silent prod break — env-var everything, test in prod with a tiny real amount.
- **Liability:** keep the human filing the government return in v1. Revisit automation only with legal review.
- **Cost meters:** Managed Agents runtime (~$0.08/hr, short bursts here) + Claude tokens + WhatsApp utility templates (Nepal rate) + Agent SDK credits (separate pool from June 15, 2026). Model your unit economics per active tenant.
```
