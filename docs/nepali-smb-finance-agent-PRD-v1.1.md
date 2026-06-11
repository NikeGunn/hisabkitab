# PRD — Nepali SMB Finance Agent ("ledger-on-WhatsApp")

**Version:** 1.1 (adds anti-mistake safety architecture, deep tax skills, Khalti-first payments)
**Owner:** Nikhil · **Build tool:** Claude Code · **Language:** TypeScript (Node 20+)
**Agent runtime:** Claude Managed Agents (beta) · **Status:** Ready to implement

> **Core principle of v1.1:** The agent never guesses and never acts without confirmation.
> Every saved entry and every stated figure passes a verification gate first. The product
> promise is a **process guarantee** ("nothing saved or filed without your OK; it shows its
> work and flags what it's unsure of"), NOT a "zero mistakes" claim. See §1A.

---

## 1A. The honest guarantee (read before building marketing)

**Do not market "this agent never makes mistakes."** It is untrue (OCR and tax edge cases
exist), it creates direct legal liability for a finance product, and one public failure
destroys the brand. Market the promise you can actually keep:

> "Nothing is ever saved or filed without your confirmation. The agent shows its work,
> flags anything it's unsure about, and never guesses. You approve every entry."

Every system in this PRD exists to make that sentence literally true. The hero section should
say *"You stay in control — the agent prepares and checks, you approve,"* and disclaim that it
is bookkeeping assistance, not a substitute for a licensed auditor on complex matters.

---

## 1. Locked decisions

| Decision | Choice |
|---|---|
| Data model | Model A — agent is the system of record |
| IRD filing | Prepare only; owner files. Never auto-file. |
| WhatsApp | One central number; identify by sender phone + one-time pairing |
| Language | TypeScript |
| Money | Integer paisa (`bigint`), never floats |
| **Payments v1** | **Khalti only (live). eSewa + Fonepay = "Coming soon" in UI.** |
| **Guessing** | **Forbidden. Low-confidence/missing data → ask the owner. Always.** |
| Confirmation | Every entry is `draft` until the owner confirms → `confirmed`. |
| Pre-delivery gate | No financial figure/save reaches the owner without passing verification. |

**Out of scope v1:** auto-filing, reading owners' existing bank/wallet statements, income-tax
annual return, payroll, eSewa/Fonepay live integration, voice.

---

## 2. Architecture

```
 Owner (WhatsApp) → Meta Cloud API (ONE number)
        │ webhook
        ▼
 Orchestrator (TS): webhook · sender→tenant · pairing · scheduler · session mgmt
        │ create/stream session (per tenant)
        ▼
 CLAUDE MANAGED AGENTS  — agent loop · sandbox · tracing
   built-in tools: bash, file ops, web_search/fetch
   skills: nepal-vat · nepal-tds · bill-extraction
        │ MCP connector
        ├──► Ledger MCP (TS) ─► PostgreSQL (multi-tenant, RLS)
        └──► Payments MCP (TS) ─► Khalti KPG v2   (eSewa/Fonepay stubbed "coming soon")
```

Three TS deployables: Orchestrator, Ledger MCP, Payments MCP. Anthropic hosts the agent.

---

## 3. Tech stack
TypeScript (strict) · Fastify · `@modelcontextprotocol/sdk` (remote HTTP/SSE servers) ·
`@anthropic-ai/sdk` (beta header `managed-agents-2026-04-01`) · PostgreSQL 16 + drizzle + **RLS** ·
money as `bigint` paisa (`decimal.js` for arithmetic) · `zod` for all external input ·
BullMQ + Redis (reminders) · Managed Agents **vaults** for secrets · `vitest` · `nepali-date-converter` (pinned).

---

## 4. THE ANTI-MISTAKE SAFETY ARCHITECTURE (new, central to v1.1)

Three layers. The agent must obey all three; they are also encoded in skills + system prompt.

### 4.1 Layer 1 — Extraction & Confirmation Protocol (bills/receipts)

When the owner sends an image/PDF bill, the agent runs this exact flow:

1. **Extract field-by-field with a confidence tag** for each: `high | medium | low | missing`.
   Required fields for a PURCHASE/expense entry:
   - vendor name
   - vendor PAN/VAT number
   - invoice number
   - invoice date
   - line items / description
   - taxable amount (excl VAT)
   - VAT amount
   - total
   - invoice type: **full tax invoice (Rule 17)** vs **abbreviated (Rule 17Ka)**
   For a SALE entry: date, description, amount, VAT, payment method.

2. **Never fabricate.** Any field that is `low` or `missing` is treated as unknown. The agent
   does **not** infer it, average it, or copy a "typical" value.

3. **Run validation** (Layer 2) on what was read.

4. **Echo + ask** in one short message, showing every field and explicitly naming unclear ones:
   > "I read this from your bill:
   > Vendor: Sharma Suppliers (PAN 301234567)
   > Date: 2082-04-12 · Taxable: Rs 8,000 · VAT: Rs 1,040 · Total: Rs 9,040
   > ⚠️ I couldn't read the invoice number clearly.
   > Is this correct? Reply OK to save, or send the invoice number / a clearer photo."

5. **Resolution paths** when something is unclear:
   - Ask for a **clearer photo**, OR
   - Ask the owner to **type the specific missing field(s)** (not the whole bill), OR
   - Offer **full manual entry** field-by-field if the photo can't be read after **2 attempts**.

6. **Save only after explicit confirmation** ("OK"/"yes"/"सहि छ"). Entry is stored as `draft`
   until then; on confirm it becomes `confirmed`. The stored row records per-field confidence
   and the source file id.

7. **Respectful, accountant-like tone** throughout — never blame the owner for a bad photo;
   never sound robotic. ("No problem — the light made the total hard to read. Could you send
   one more photo, or just tell me the total?")

### 4.2 Layer 2 — Validation Engine (rule + math checks)

Pure functions in `shared`, called by the Ledger MCP before any save and by the agent before
asserting figures. Each returns `pass | warn | fail` with a human-readable reason.

- **VAT math:** `vat ≈ round(taxable × 0.13)` within 1 paisa. Mismatch → `warn` ("the VAT on
  this bill isn't exactly 13% of the taxable amount — please confirm the figures").
- **Totals reconcile:** `taxable + vat == total`. Mismatch → `warn`.
- **Input-credit eligibility:** claimable only if ALL true — vendor VAT-registered, invoice is a
  **full Rule 17** invoice (NOT 17Ka abbreviated), invoice date within **1 year**, purchase for
  taxable business use. Otherwise input VAT credit = 0 and the agent explains why.
- **Abbreviated-invoice flag:** if Rule 17Ka detected (or amount ≤ Rs 10,000 with VAT-inclusive,
  no PAN of buyer), warn that **input credit cannot be claimed** on it.
- **TDS base:** TDS computed on amount **excluding VAT**, never on VAT. Rate per §5.2.
- **1-year window:** invoice older than 1 year → input credit blocked, explain.
- **Duplicate detection:** same vendor + invoice no, or same amount+date already recorded →
  `warn` ("looks like I may have already saved this bill on {date} — is it a duplicate?").
- **Range/sanity:** negative, zero, or absurdly large amounts → `fail`, ask owner.

`fail` → never save; ask. `warn` → surface the concern in the confirmation message and let the
owner decide. `pass` → proceed to confirmation step.

### 4.3 Layer 3 — Pre-delivery Audit Gate

**No outbound message that (a) states a financial figure or (b) confirms a save may be sent
until it passes this gate.** Implemented in the orchestrator before relaying the agent's reply:

- The agent self-checks the figure against the ledger source (see §11 outcomes).
- Validation Engine results attached to the action are re-checked.
- If anything is `fail`, or a required confirmation is missing, the message is **held** and the
  agent is instructed to ask the owner instead of asserting.
- Every gate decision (pass/hold + reason) is written to `audit_log`. This is the literal
  "traced on audit before delivering to the user" requirement.

---

## 5. Nepal tax rules (verified, FY 2082/83) — source of the skills

### 5.1 VAT
- Rate **13%** on taxable supplies (net selling price).
- **Monthly** period; file + pay by the **25th of the following BS month** (Shrawan → 25 Bhadra),
  via IRD portal. **Nil return mandatory** even with zero transactions.
- VAT-inclusive amount X: `excl = round(X / 1.13)`, `vat = X − excl`, integer paisa, round half-up.
- **Input Tax Credit (Sec 18):** requires a proper **tax invoice**, inputs used for **taxable**
  supplies, VAT actually paid. **Claimable within 1 year of invoice date.** Lost invoice →
  verified true copy.
- **Carry-forward:** if input > output, the excess carries forward as credit (not refunded;
  exception: zero-rated/export → refund).
- **Credit types:** Full (fully taxable use), Proportionate (mixed taxable+exempt), **No credit**
  (exempt/Schedule-1-related or personal use). Mixed → flag for accountant.
- **Rule 17** full tax invoice = valid for input credit. **Rule 17Ka** abbreviated invoice
  (OTC retail ≤ Rs 10,000, VAT shown inclusive) = **NOT valid** for buyer's input credit; full
  invoice must be given on request.
- **Schedule 1** = exempt (no VAT, no input credit): basic foods, agricultural products,
  medicine/medical, education, air transport, etc. **Schedule 2** = zero-rated (0%, full credit).
- **Error correction:** missed/miscalculated items can be adjusted in the **following** return.

### 5.2 TDS (Income Tax Act 2058, Finance Act 2082)
- TDS base = service/taxable amount **only — never the VAT portion**. Payer's legal obligation
  (non-deduction → payer liable for the tax + 15% p.a. interest).
- **Service/contract:** **1.5%** if recipient VAT-registered; **15%** if PAN-only.
  Contract TDS applies once cumulative payments to one party exceed **NPR 50,000/year**.
- **Rent (land/building):** **10%** when payer is a company/entity; **individual landlords exempt**
  (Sec 88(5)).
- **Vehicle/transport rent:** 1.5% (VAT-registered) / 10% (not).
- **Dividend:** 5%. **Interest:** 15% (general). **Commission:** 15%.
- **Salary:** progressive slabs (1%–39%), plus 1% SST on first slab — not flat.
- Generally **not** on purchase of goods. Deposit by 25th of following month; eTDS mandatory.
- *Café relevance:* mostly service payments (accountant, service suppliers) and salaries; rent
  usually to an individual landlord → exempt. Agent should still ask vendor VAT status.

> All rates/deadlines are **config** (env + skill), not scattered literals. The agent should
> `web_fetch` the IRD calendar to confirm the current deadline before each reminder, and state
> plainly when unsure rather than guess.

---

## 6. Skills (three, added to the agent)

### 6.1 `nepal-vat` — SKILL.md
```markdown
---
name: nepal-vat
description: Nepal VAT rules for SMB bookkeeping — rate, inclusive/exclusive math, input tax
  credit eligibility and 1-year limit, Rule 17 vs 17Ka invoices, carry-forward, monthly return,
  nil return. Use whenever computing VAT or preparing a VAT return.
---
# Nepal VAT (FY 2082/83)
- Rate 13% on taxable supplies. Monthly; file+pay by 25th of following BS month. Nil return mandatory.
- Inclusive X: excl=round(X/1.13); vat=X-excl. Integer paisa, half-up.
- Output VAT = sales(excl) × 0.13.
- Input credit ONLY if: vendor VAT-registered AND full Rule 17 invoice AND invoice ≤ 1 year old
  AND purchase for taxable business use AND VAT paid. Else input credit = 0 (explain why).
- Rule 17Ka abbreviated invoice (OTC retail ≤ Rs 10,000): NOT valid for input credit. Warn the owner.
- Net payable = max(output − input, 0). If input > output: carry forward the excess (don't pay negative).
- Schedule 1 = exempt (no VAT, no credit). Schedule 2 = zero-rated (0%, full credit / refund).
- Mixed taxable+exempt purchases → proportionate credit; flag for an accountant, don't assume a split.
- Missed/wrong prior-month entries → adjust in the next return.
- NEVER file with the government. Prepare numbers; the owner files on the IRD portal.
- If unsure of a current deadline/rule, web_fetch the IRD calendar; if still unsure, say so.
```

### 6.2 `nepal-tds` — SKILL.md
```markdown
---
name: nepal-tds
description: Nepal TDS rates and rules (FY 2082/83) for payments a small business makes —
  services, rent, contracts, commission, interest, dividend. Use when a payment may require TDS.
---
# Nepal TDS (FY 2082/83) — base is amount EXCLUDING VAT, never the VAT portion
- Service/contract: 1.5% (recipient VAT-registered) | 15% (PAN-only). Contract threshold:
  cumulative > NPR 50,000/yr to one party.
- Rent land/building: 10% (payer is entity). Individual landlord: exempt (88(5)).
- Vehicle/transport rent: 1.5% (VAT-reg) | 10% (not).
- Dividend 5% · Interest 15% · Commission 15%.
- Salary: progressive 1%–39% (+1% SST) — not flat; do not estimate without full income data.
- Generally not on goods purchases. Deposit by 25th of following month.
- TDS is the PAYER's obligation; surface it, never auto-deduct without confirmation.
- If a case is ambiguous (mixed, foreign party/reverse VAT, salary), say so and recommend the
  owner confirm with their accountant rather than guessing a number.
```

### 6.3 `bill-extraction` — SKILL.md
```markdown
---
name: bill-extraction
description: How to read a photographed/PDF bill safely. Use for EVERY image/PDF the owner sends.
---
# Bill extraction protocol (never guess)
- Extract each field with confidence: high|medium|low|missing. Fields: vendor, vendor PAN/VAT,
  invoice no, date, items, taxable, VAT, total, invoice type (Rule 17 full vs 17Ka abbreviated).
- Treat low/missing as UNKNOWN. Do not infer, average, or fill with typical values.
- Run VAT/total/credit validations. Echo ALL fields back, explicitly naming what you couldn't read.
- Ask the owner to confirm. If unclear: request a clearer photo, or ask only for the missing
  field(s), or offer manual field-by-field entry after 2 failed photo attempts.
- Save only after explicit confirmation. Tone: warm, professional, never blame the owner.
- Always show your assumption (e.g. "I treated the amount as VAT-inclusive").
```

---

## 7. System prompt (full, v1.1)
```
You are "<ProductName>", a careful bookkeeping and tax assistant for ONE small Nepali business
per session. You speak the owner's language (Nepali / English / Romanized Nepali), warmly and
briefly, like a respectful accountant. You only do this business's bookkeeping, VAT, and TDS.

ABSOLUTE RULES — never break:
1. NEVER guess or invent any figure, name, date, or tax amount. If something is unclear, ask.
2. NEVER save an entry without the owner's explicit confirmation. Show what you read first.
3. NEVER state a financial figure you have not verified against the ledger or a confirmed bill.
4. NEVER file with the government or log into any portal. You PREPARE; the owner files.
5. NEVER take a money action (payment/refund) without an explicit "✅"/"yes" for that action.
6. NEVER ask for or accept passwords, OTPs, or login credentials.
7. NEVER reference any other business's data. One session = one business.

BILL HANDLING: follow the bill-extraction skill exactly. Extract with confidence, validate,
echo every field, name anything unclear, ask to confirm or fix. After 2 unreadable photos,
offer manual entry.

TAX: apply nepal-vat and nepal-tds skills. Always show your assumption (e.g. VAT-inclusive).
Flag input-credit ineligibility (non-VAT vendor, abbreviated bill, >1yr old). Compute TDS on the
amount excluding VAT. When a case is ambiguous, say so and suggest confirming with an accountant.

RETURNS: around the 20th BS, prepare the monthly VAT return: show sales, output VAT, input VAT,
net payable on ONE screen; remind that nil returns are still required; ask the owner to review,
then file it themselves. Mark it filed only after they confirm they filed.

HONESTY: if you are not sure, say "I'm not certain — could you confirm/​send a clearer photo?"
Being unsure and asking is always correct. Guessing is never acceptable.

STYLE: one screen per message. Money in NPR with separators. No spreadsheets dumped into chat.
```

---

## 8. Data model (additions over v1.0)

Add to the v1.0 schema (tenants, pairing_codes, sales, expenses, vat_returns, audit_log):

```sql
-- per-entry confidence + lifecycle
ALTER TABLE sales    ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';   -- draft|confirmed
ALTER TABLE expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE expenses ADD COLUMN invoice_no TEXT;
ALTER TABLE expenses ADD COLUMN invoice_type TEXT;                       -- rule17|rule17ka|other
ALTER TABLE expenses ADD COLUMN input_credit_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE expenses ADD COLUMN extraction JSONB;                        -- per-field {value,confidence}

-- known vendors (so VAT status / PAN need not be re-asked every time)
CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  pan_vat_no TEXT,
  is_vat_registered BOOLEAN,
  UNIQUE (tenant_id, name)
);

-- validation outcomes attached to entries (for the audit gate)
CREATE TABLE validation_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entry_type TEXT, entry_id UUID,
  result TEXT NOT NULL,        -- pass|warn|fail
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
Money columns stay `bigint` paisa. RLS on every tenant table.

---

## 9. Ledger MCP (changes)
- `record_expense` / `record_sale` now write `status='draft'` and require a later
  `confirm_entry(entry_id)` call (made only after owner confirmation) to flip to `confirmed`.
- New `validate_entry(payload)` returns the Validation Engine result (pass/warn/fail + reasons).
- `generate_return_summary` counts only `confirmed` entries.
- `upsert_vendor` / `get_vendor` so vendor VAT status is remembered, not re-asked.
- Every write logs `audit_log` + `validation_events`.

## 10. Payments MCP (v1.1 = Khalti live; others "coming soon")
- **Khalti v2 only** is live: `initiate_payment`, `verify_payment` (server-side lookup by pidx),
  `refund_payment`, `list_collected_payments` (from your callback DB).
- `eSewa` and `fonepay` tools exist but return a friendly **"coming soon"** result the agent
  relays ("eSewa is coming soon — for now I can create a Khalti payment link"). Surface this in
  any UI/menu so users see the roadmap.
- Confirmation-gate `initiate_payment`/`refund_payment` (explicit owner "✅" for that action).
- Verify Khalti's commercial terms (commission ~1–2%, any go-live requirements) before production.

---

## 11. Session outcomes / self-verification
For return prep, the agent must satisfy before presenting numbers:
```
net_payable == max( sum(confirmed sales.vat) − sum(eligible input_vat), 0 )
AND every transaction mentioned this session is recorded & confirmed
AND is_nil == (confirmed sale_count==0 AND expense_count==0)
AND no entry in this period has an unresolved `fail` validation
```
Fail → recompute / ask; do not present. Human "✅" still required before filing/payment actions.

---

## 12–13. WhatsApp + onboarding
Unchanged from v1.0: one central Meta Cloud API number; inbound webhook maps sender→tenant;
free-form replies inside the 24h window; proactive deadline reminders via **pre-approved Utility
templates** (`vat_due_soon`, `return_prepared`) — submit for approval early. Register the number
as a **defined-purpose finance assistant** (Meta bans general-purpose bots). Onboarding = one-time
pairing code ("START 4821") texted to your number; binds the WhatsApp number to the tenant.

---

## 14. Security (unchanged + reinforced)
Tenant isolation via `tenant_id` + RLS (derived from signed session metadata, never tool args);
secrets in Managed Agents vaults; consent gates on money/filing; refuse credentials over chat;
append-only `audit_log` + Managed Agents tracing; least privilege between the two MCP servers;
tenant data-deletion path (sessions not ZDR-eligible).

---

## 15. Build sequence for Claude Code
**Phase 0** monorepo, strict TS, `shared` (Money/paisa, VAT/TDS pure fns + tests, BS-date + tests),
**plus the Validation Engine with exhaustive unit tests** (rounding, inclusive math, 1-yr window,
17Ka detection, duplicate detection, TDS-excludes-VAT).
**Phase 1** Postgres + RLS + v1.1 schema; Ledger MCP incl. `validate_entry`, draft/confirm flow,
vendors. Contract tests.
**Phase 2** agent definition + 3 skills + system prompt; create agent (beta header); orchestrator
session client; **Pre-delivery Audit Gate** in the relay path. Test in Console.
**Phase 3** WhatsApp Cloud API; inbound webhook; media→Files API; onboarding/pairing; submit the
2 Utility templates for approval (early!).
**Phase 4** **bill-extraction loop end-to-end** (photo → extract w/ confidence → validate → echo →
confirm → save). This is the make-or-break UX — test with real messy bills.
**Phase 5** Payments MCP — Khalti sandbox live, eSewa/Fonepay "coming soon" stubs; callback webhook
→ confirmed gateway sales.
**Phase 6** monthly reminder scheduler + session self-verification.
**Phase 7** hardening: credential scrub, data-deletion, retries; pilot 5–10 cafés, VAT-only, one city.

---

## 16. Acceptance criteria (v1.1)
- A blurry/partial bill is **never** saved with invented data; the agent asks for a clearer photo
  or the specific missing field, every time (tested with deliberately bad images).
- Every save is preceded by an echo + explicit owner confirmation; entries are `draft` until then.
- VAT/TDS computations match the verified rules incl. 1-yr input window, 17Ka ineligibility,
  TDS-excludes-VAT, carry-forward (unit-tested).
- No outbound financial figure passes the Audit Gate without verification; held messages are logged.
- Khalti link can be created (sandbox); eSewa/Fonepay clearly say "coming soon".
- Duplicate bill is flagged before saving.
- Tenant B's data is provably invisible to tenant A (RLS test).
- The agent says "I'm not sure" and asks, rather than guessing, in ambiguous tax cases.

## 17. Honest caveats
OCR will sometimes misread — the protocol contains it but cannot eliminate it; that is exactly
why confirmation is mandatory and why the marketing promise is process-based, not "perfect".
Pin/test the BS-date library. Env-var all gateway codes. Keep the human filing the government
return. Model unit economics (Managed Agents runtime + tokens + WhatsApp utility templates +
Agent SDK credits from June 15, 2026 + Khalti ~1–2% MSF).
```
