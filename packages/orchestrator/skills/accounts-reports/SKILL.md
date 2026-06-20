---
name: accounts-reports
description: How to track who owes the business (receivables/debtors) and who it owes
  (payables/creditors), record credit sales/purchases and payments with allocation, answer
  flexible account questions from real data, and generate professional PDF reports (debtors,
  creditors, statement of account, sales summary). Use whenever the owner asks about debtors,
  creditors, outstanding balances, "who owes me", statements, aging, or wants a report/PDF.
---
# Accounts: receivables, payables, statements & reports

You PREPARE and SHOW; nothing is saved without the owner's explicit confirmation, and no figure or
report leaves until it reconciles. Every number you state must come from a tool result — never
hand-computed, never guessed.

## Recording on credit (draft → confirm, like every entry)
- **Credit sale (you invoiced a customer, AR):** `record_credit_sale` with the party name, amount
  (VAT-inclusive unless told otherwise), `issued_on`, and `due_on` if the owner gives one. It returns
  a DRAFT with the VAT split and the opening balance. Echo it, get the owner's "✅", then
  `confirm_arap_entry` (entry_type `ar_invoice`).
- **Credit purchase (a supplier billed you, AP):** `record_credit_purchase` — also asks vendor VAT
  status (do not guess) and flags input-credit eligibility per the VAT rules. Confirm the same way.
- If the owner has no due date, leave it out — never invent one (aging will show "no due date").

## Payments against invoices/bills (allocation)
- **Payment received / paid:** `record_party_payment` with the party, `direction`
  (received for AR, paid for AP), amount, and date.
  - Omit `allocate` to auto-apply **oldest-first** across the party's open invoices/bills. The tool
    returns the planned lines (which invoices it clears, the new balances). Echo that to the owner.
  - Or pass `allocate: [{target_id, amount_paisa}, …]` when the owner says exactly which to apply to.
  - It returns a DRAFT; the balances move only after `confirm_arap_entry` (entry_type `party_payment`),
    which applies the allocation atomically. Get the owner's "✅" first.
  - If the payment is more than the total owed, the tool refuses — ask the owner whether it's an
    advance/overpayment; never silently absorb it.

## Answering account questions (flexible, from real data)
Use the read-only analytics tools and report the figures they return:
- `get_receivables_summary` / `get_payables_summary` — debtors/creditors with balances, days overdue,
  and aging buckets. "Who owes me?", "how much is overdue?"
- `get_statement` (party) — every invoice/bill/payment with a running balance. "Did Sharma clear it?"
- `get_sales_summary` (bs_year, bs_month) — gross/VAT/net/count for a Nepali month.
- `get_top_parties` (receivable|payable, n) — "who owes me the most?", "which supplier do I owe most?"
Offer a PDF when it would help ("want this as a statement?").

## Generating a professional PDF report
When the owner wants a report/PDF/statement:
1. If you don't already have the figures, you MAY call the matching analytics tool first so you can
   acknowledge with the real totals.
2. Call `request_report` with `report_type` (receivables | payables | statement | sales_summary).
   - `statement` needs `party`. `sales_summary` needs `bs_year` + `bs_month`. `as_of` is optional.
3. Acknowledge immediately: "Sure — preparing your {debtors/…} statement as of {date}. I'll send the
   PDF in a moment once the numbers check out." State only figures you got from a tool, or none.
4. The backend validates, renders, RECONCILES, and sends the PDF as a WhatsApp document. If it can't
   reconcile, it holds the report and tells the owner — it never sends a report whose totals don't tie.

## Corrections & sequential invoice numbers (P13)
- **Never edit a confirmed invoice.** A return, cancellation, or correction is a NOTE that references
  the original:
  - `issue_note` with `kind: 'credit'` to REDUCE/refund (a return or over-bill), or `kind: 'debit'`
    to ADD (an under-bill correction). Pass `original_invoice_id` (must be a CONFIRMED AR invoice),
    `issued_on`, `amount_paisa` (VAT-inclusive unless `inclusive: false`), and a `reason`.
  - It returns a DRAFT with the recomputed VAT split and an allocated note number. Echo it, get the
    owner's "✅", then `confirm_note`. A credit note can never exceed the original — the tool refuses,
    so ask the owner to correct the amount.
- **Gap-free invoice numbers:** `next_invoice_number` allocates the next sequential number for the
  fiscal year of `issued_on` (IRD Rule-17 requires no gaps; the series resets each BS fiscal year).
  Use it when the owner needs a proper sequential number for an invoice or note.

## TDS deposit, opening balances, backdating & the year-end view (P13)
- **TDS deposit reminder:** TDS withheld in a month must be DEPOSITED by the 25th of the following
  BS month (same cutoff as VAT). `generate_tds_summary` totals the TDS withheld on confirmed expenses
  for a BS month and returns the deposit deadline. It only PREPARES the figure; the owner deposits via
  eTDS. (The scheduler also sends a proactive TDS nudge each month, self-verified like the VAT one.)
- **Opening balances (onboarding mid-year):** if a business already had open debtors, creditors, or a
  carried VAT credit before joining, seed them so the first report is accurate. `record_opening_balance`
  with `kind: 'receivable'` or `'payable'` (each needs `party_id`) or `'vat_credit'` (no party), an
  `amount_paisa` (> 0) and `as_of` cutover date. It is a DRAFT; echo it, get the owner's "✅", then
  `confirm_opening_balance`. These are owner-asserted facts, never guesses.
- **Backdated entries:** record a late-logged sale/bill on the date it actually occurred (`occurred_on`).
  The tool attributes it to the correct BS month automatically and flags it backdated; if it lands in a
  return period the owner already prepared, it tells you to re-run `generate_return_summary` for that
  month. A future-dated entry is refused. Never move the date to "now" to avoid the flag.
- **Year-end view & carry-forward:** `get_annual_summary` rolls the VAT credit forward across a whole BS
  fiscal year (Shrawan to Ashadh) from confirmed entries: each month's settlement, annual totals, and
  the credit carried into the next fiscal year. Read-only; numbers come from the deterministic engine.

## Compliance calendar (NEVER guess a date)
- **Dates are not yours to compute.** For any "when is X due / how many days until / is it a holiday /
  when does the fiscal year end" question, call the calendar tool and quote it. Never count days or name
  a deadline from memory.
  - `get_upcoming_deadlines` lists VAT filing, TDS deposit, fiscal-year boundaries, and the owner's open
    invoice/bill due dates with exact AD + BS dates and days remaining. Use it for "what's due / what's coming".
  - `days_until_deadline` gives the exact day count to any AD date. Use it for "how many days until".
  - `is_business_holiday` checks a date against the configured holidays.
- **A deadline on a holiday is NOT moved.** If the tool returns a `holiday_warning`, tell the owner the
  statutory date stands and they should confirm any IRD extension. Do not assume a shifted date.
- The owner also gets a once-a-month calendar digest automatically; that is a nudge, not a substitute for
  pulling the live list when they ask.

## Always
- Confirm before saving; reconcile before sending. When unsure, ask — that is always correct.
- Reports reflect only what's been recorded; gently remind the owner to log transactions for
  completeness. The PDF footer states it's a cross-check, not audited statements.
