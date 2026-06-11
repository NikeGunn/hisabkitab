# PRD Addendum — Module C: Reports, Receivables/Payables & Flexible Analytics

**Version:** 1.2 (append to PRD v1.1) · **Owner:** Nikhil · **Build:** Claude Code · **Lang:** TypeScript

> This module adds: on-demand **professional PDF reports** (debtors/receivables, creditors/payables,
> statements, sales/VAT/P&L-lite), an **Accounts Receivable/Payable** data layer, a **flexible
> analytics** capability so the owner can "play around" with account questions, and a **scope
> guardrail** so the agent answers account questions but politely declines unrelated ones.
> Everything inherits v1.1's safety rules: never guess, confirm before save, validate + re-verify,
> Pre-delivery Audit Gate before any figure or file reaches the owner.

---

## C0. Positioning & pricing (honest)

- **Price:** Rs 3,000/month is defensible *only if* the PDF output is genuinely professional and
  the underlying data is reliable. The reports are the value, not chat.
- **Positioning:** "**Your pocket accountant** — pull a clean debtors/creditors statement or VAT
  position any time, and **cross-check what your accountant gives you**."
- **Liability guardrail (keep this):** market it as bookkeeping assistance and a cross-check tool,
  **not** a replacement for a licensed auditor signing statutory accounts. This is a selling point
  (lower friction, "verify your accountant") *and* protects you legally.
- Every report carries a footer: *"Prepared as of {date}, based on entries recorded in the system.
  Not a substitute for audited financial statements."*

---

## C1. New capabilities in scope

1. **On-demand professional PDF reports**, requested in natural language on WhatsApp, delivered as
   a document after a short verified backend process. Report types:
   - **Debtors / Receivables aging** — who owes the business, amounts, due dates, days overdue,
     aging buckets.
   - **Creditors / Payables aging** — who the business owes, amounts, due dates, overdue.
   - **Statement of Account** for a single party (all invoices, payments, running balance).
   - **Sales summary** (period), **VAT position** (BS month, output/input/net so far), **P&L-lite**
     (income vs expense for a period).
2. **Flexible analytics** — answer ad-hoc account questions by computing over the tenant's data.
3. **Scope guardrail** — answer accounts questions; decline unrelated ones respectfully.

Out of scope (still): auto-filing; statutory audited statements; full double-entry GL/journals
(v1.2 is AR/AP + cash, not a full ledger); payroll.

---

## C2. Data model additions (AR/AP)

Extends v1.1. Money is `bigint` paisa; every table has `tenant_id` + RLS.

```sql
-- unify customers & suppliers (replaces/extends v1.1 `vendors`)
CREATE TABLE parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  pan_vat_no TEXT,
  is_vat_registered BOOLEAN,
  kind TEXT NOT NULL DEFAULT 'both',         -- customer | supplier | both
  phone TEXT,
  UNIQUE (tenant_id, name)
);

-- Accounts Receivable: invoices the business issued on credit
CREATE TABLE ar_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  party_id UUID NOT NULL REFERENCES parties(id),
  invoice_no TEXT,
  issued_on DATE NOT NULL,
  due_on DATE,                                -- expected receipt date
  taxable_paisa BIGINT NOT NULL,
  vat_paisa BIGINT NOT NULL,
  total_paisa BIGINT NOT NULL,
  balance_paisa BIGINT NOT NULL,              -- decremented by allocations
  status TEXT NOT NULL DEFAULT 'draft',       -- draft|confirmed (open/partial/paid derived from balance)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accounts Payable: bills the business owes on credit
CREATE TABLE ap_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  party_id UUID NOT NULL REFERENCES parties(id),
  bill_no TEXT,
  billed_on DATE NOT NULL,
  due_on DATE,
  taxable_paisa BIGINT NOT NULL,
  vat_paisa BIGINT NOT NULL,
  total_paisa BIGINT NOT NULL,
  balance_paisa BIGINT NOT NULL,
  input_credit_eligible BOOLEAN NOT NULL DEFAULT false,  -- per v1.1 rules
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- payments received (AR) and paid (AP), with allocation to specific invoices/bills
CREATE TABLE party_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  party_id UUID NOT NULL REFERENCES parties(id),
  direction TEXT NOT NULL,                    -- received | paid
  amount_paisa BIGINT NOT NULL,
  paid_on DATE NOT NULL,
  method TEXT,                                -- cash|khalti|bank
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  payment_id UUID NOT NULL REFERENCES party_payments(id),
  target_type TEXT NOT NULL,                  -- ar_invoice | ap_bill
  target_id UUID NOT NULL,
  amount_paisa BIGINT NOT NULL
);
```

**Aging buckets** (computed, not stored): `current` (not yet due), `1–30`, `31–60`, `61–90`,
`90+` days past `due_on`, measured against the report's as-of date.

---

## C3. Recording flows (all via the v1.1 confirm protocol)

- **Credit sale / invoice issued:** owner says "billed Sharma Rs 9,040 due in 30 days" or sends the
  invoice photo → bill-extraction → validate (VAT math, totals) → echo → confirm → `ar_invoices`
  (`balance = total`).
- **Payment received:** "got Rs 5,000 from Sharma" → agent shows Sharma's open invoices, asks which
  to apply against (or auto-applies oldest-first and shows the result) → confirm → `party_payments`
  + `payment_allocations`, decrement invoice `balance`.
- **Credit purchase / bill, payment made:** symmetric for AP, with input-credit eligibility per v1.1.
- Every write is `draft` → `confirmed` only after explicit owner OK; logged to `audit_log` +
  `validation_events`.

---

## C4. Report engine

### C4.1 Determinism rule (critical)
The agent chooses the **report type + filters + period**. The **Reports service renders the PDF
from validated query results using a fixed template.** The model never hand-writes numbers into the
document. This is what makes output professional and audit-safe.

### C4.2 Async "2–5 minute" delivery flow
1. Owner asks (e.g., "send me the debtors list with due dates till date").
2. Agent **acknowledges immediately**: "Sure — preparing your debtors summary as of today. I'll
   send the PDF in a few minutes once I've checked the numbers."
3. Backend job (BullMQ): (a) pull confirmed AR rows for the tenant, (b) **validate** each entry
   (balances ≥ 0, allocations reconcile, totals = taxable+VAT), (c) **compute** aging, (d) **render**
   the PDF from the fixed template, (e) **re-verify**: sum of rows == report total == ledger total;
   bucket sums == grand total, (f) pass the **Pre-delivery Audit Gate** (hold + ask if any check
   fails; never send a report that doesn't reconcile).
4. Deliver the PDF as a **WhatsApp document message** (free-form, inside the open 24h window since the
   owner just messaged) with a one-line summary: "Here's your debtors summary as of {date}: total
   receivable Rs {X}, of which Rs {Y} is overdue. 8 customers."

### C4.3 Professional PDF template (deterministic)
- **Header:** business name, PAN/VAT no, report title, period / as-of date, generated timestamp.
- **Body table:** Party · Invoice no · Issued · Due · Total · Paid · **Balance** · Days overdue.
- **Aging summary block:** Current / 1–30 / 31–60 / 61–90 / 90+ with subtotals + grand total.
- **Footer:** the as-of/disclaimer line (C0), page numbers, optional logo.
- **Rendering:** HTML+CSS template → PDF via headless Chromium (Playwright) for typography quality;
  fallback `pdfmake`/`@react-pdf/renderer`. Numbers come only from the validated query result object.
- Same template family for Creditors (AP), Statement of Account (per party, running balance),
  Sales summary, VAT position, P&L-lite.

---

## C5. Flexible analytics ("play around"), done safely

The owner can ask open-ended account questions. The agent answers by:
1. Calling **structured, tenant-scoped analytics tools** (no raw SQL exposed to the model), and/or
2. Fetching JSON via read tools and **computing in its sandbox** for novel questions.

Examples it should handle: "who owes me the most?", "total sales last Ashar?", "how much VAT so far
this month?", "which supplier do I owe the most?", "average days my customers take to pay?",
"top 5 customers this year?", "did Sharma clear last month's bill?"

For any of these it may also offer to render a PDF ("want this as a statement?").

---

## C6. Scope guardrail (defined-purpose)

Add to the system prompt:
```
You answer questions about THIS business's accounts: sales, purchases, debtors (receivables),
creditors (payables), payments, VAT, TDS, statements, and summaries — and you can generate reports
for them. You are flexible: if a question is about this business's money or accounts, help.

If a request is NOT about this business's accounts (general knowledge, news, public figures,
other businesses, jokes, coding, anything off-topic), do not attempt it and do not guess. Respond
briefly and respectfully, then offer what you can do. Example:
  Owner: "who is Elon Musk?"
  You: "I'm your accounts assistant for {business}, so that's outside what I can help with. But I
       can pull your debtors, sales, VAT, or a statement any time — want one?"
Never be rude or dismissive. Never pretend to know something you don't — saying "I don't know /
that's outside my area" is always correct.
```

---

## C7. New MCP tools (Ledger/Reports server)

```ts
// recording
record_credit_sale(party, invoice_no?, issued_on, due_on?, amount_paisa, inclusive) -> draft ar_invoice
record_credit_purchase(party, bill_no?, billed_on, due_on?, amount_paisa, inclusive, vendor_is_vat_registered, invoice_type) -> draft ap_bill
record_payment(party, direction, amount_paisa, paid_on, method, allocate?: [{target_id, amount}]) -> draft
confirm_entry(entry_type, entry_id) -> confirmed   // only after owner OK

// analytics (structured, tenant-scoped, parameterized server-side)
get_receivables_summary(as_of: date) -> { rows:[{party, invoice_no, issued_on, due_on, total, paid, balance, days_overdue}], aging:{...}, total }
get_payables_summary(as_of: date)    -> { ... }
get_statement(party_id, from?, to?)  -> { lines:[...], running_balance, closing_balance }
get_sales_summary(period)            -> { gross, vat, net, count }
get_vat_position(bs_year, bs_month)  -> { output, input_eligible, net_payable_so_far }
get_top_parties(metric, n, period?)  -> { rows:[...] }
analyze(entity, metric, group_by?, filters?, period?) -> structured result   // flexible but constrained

// report generation (deterministic render → file)
generate_report(report_type, filters, period_or_as_of) ->
  { report_id, file_id, summary_line, reconciled: boolean, checks:[{name,result}] }
```

Rules: every analytics/report query is scoped to the session's `tenant_id` (from signed metadata,
never args). `generate_report` returns `reconciled:false` + failing `checks` if totals don't tie —
the orchestrator then holds delivery and the agent asks instead of sending.

---

## C8. WhatsApp delivery
- Reports delivered as **document (PDF) messages** via Cloud API media upload, free-form within the
  owner's open 24h window (they just asked, so the window is open).
- If a report is requested and then takes longer than the window (rare), fall back to a pre-approved
  Utility template ("Your {report} is ready") that re-opens the conversation, then send the document.

---

## C9. Safety (inherits v1.1, extended)
- Reports never render from unconfirmed (`draft`) entries.
- Re-verification step: row sums == report total == independent ledger total == sum of aging buckets.
  Mismatch → **hold + ask**, log to `audit_log`/`validation_events`. A report that doesn't reconcile
  is never delivered.
- The model formats narrative only; **all numbers originate from validated query objects.**
- Analytics tools are read-only and parameterized; the model cannot run arbitrary SQL.

---

## C10. Acceptance criteria (Module C)
- "Send me my debtors list with due dates" → within ~minutes the owner receives a clean PDF whose
  total receivable equals the sum of confirmed open invoice balances, with correct aging buckets and
  the as-of/disclaimer footer.
- Same for creditors/payables and per-party statements (running balance reconciles to zero error).
- A report whose totals don't reconcile is **held**, not sent; the event is logged and the agent asks.
- Flexible questions ("who owes me most?", "VAT so far?") are answered from real data; the agent
  offers a PDF where useful.
- Off-topic request ("who is Elon Musk?") gets a brief, respectful decline + an offer of what it can do.
- All recording (credit sale, payment received) passes draft→confirm; nothing saved without OK.
- Tenant B cannot appear in tenant A's reports/analytics (RLS test).

## C11. Build phases (append to v1.1 sequence)
- **C-1:** AR/AP schema + RLS; `parties`, `ar_invoices`, `ap_bills`, `party_payments`,
  `payment_allocations`; recording tools with draft→confirm; allocation logic + unit tests
  (balance decrement, oldest-first apply, over-allocation rejection).
- **C-2:** analytics tools + `analyze`; aging computation with unit tests (bucket boundaries,
  as-of dates, partial payments).
- **C-3:** Reports service: fixed HTML→PDF template (Playwright), one report type end-to-end
  (Debtors), reconciliation re-verify + Audit Gate hold path, WhatsApp document delivery.
- **C-4:** remaining report types (Creditors, Statement, Sales, VAT position, P&L-lite).
- **C-5:** scope guardrail prompt + tests (in-scope answered, off-topic declined respectfully).

## C12. Honest caveats
- Reports reflect **only what's been entered** — accuracy depends on the owner recording sales/bills.
  The footer states this; the agent should gently remind owners to log transactions for complete
  reports. This is also why the "cross-check your accountant" positioning is honest: it cross-checks
  against *recorded* data, surfacing gaps, not certifying completeness.
- Aging needs `due_on`; if an invoice has no due date, show it as "no due date" rather than guessing one.
- Keep the auditor-replacement disclaimer; never imply statutory sign-off.