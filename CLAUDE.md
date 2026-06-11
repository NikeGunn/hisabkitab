# CLAUDE.md — Nepali SMB Finance Agent ("ledger-on-WhatsApp")

You are building a WhatsApp-first bookkeeping & tax assistant for small VAT-registered
businesses in Nepal. Read this file fully, then read the three spec files below before
writing any code. This file is the authority on **rules and process**; the PRDs hold the detail.

## 1. Read the specs first (in this order; later versions win on conflict)
1. `docs/nepali-smb-finance-agent-PRD.md` — **v1.0 base** (architecture, base schema, WhatsApp, onboarding).
2. `docs/nepali-smb-finance-agent-PRD-v1.1.md` — **v1.1, authoritative** for the safety architecture and
   the verified VAT/TDS rules. Overrides/extends v1.0 where they differ.
3. `docs/nepali-smb-finance-agent-PRD-v1.2-reports-module.md` — **Module C**: AR/AP, PDF reports, analytics.
4. `docs/nepali-smb-finance-agent-PRD-v2.0-production-growth.md` — **commercialization layer** (billing,
   multi-user/roles, voice, idempotency, cost, observability, security, CI/CD, growth, accounting
   completeness). **Build AFTER the v1 pilot validates retention** — do not build v2 up front.

`docs/PRODUCT.md` is the index + product one-pager; start there for orientation. Project name: **HisabKitab** (hisabkitab).

If anything is ambiguous or two specs conflict in a way precedence doesn't resolve, **stop and ask me** —
do not guess. (Guessing is also forbidden at runtime; mirror that discipline while building.)

## 2. The product promise (every system must make this literally true)
"Nothing is ever saved or filed without the owner's confirmation. The agent shows its work, flags
anything it's unsure about, and never guesses." We do NOT claim "zero mistakes." Build to the process.

## 3. Non-negotiable rules
- **Never fabricate data.** Low-confidence/missing → ask the owner (clearer photo or specific field).
- **Confirm before save.** Every entry is `draft` until the owner explicitly confirms → `confirmed`.
- **Pre-delivery Audit Gate.** No outbound message stating a financial figure, and no report, may be
  sent unless it passes verification + reconciliation. On fail → hold + ask. Log every gate decision.
- **Money = integer paisa (`bigint`), never floats.** Use `decimal.js` for arithmetic. 1 NPR = 100 paisa.
- **Never auto-file to the government** and never log into any portal. Prepare numbers; the owner files.
- **No money action** (payment/refund) without an explicit owner "✅" for that specific action.
- **Never accept credentials** (passwords/OTPs/logins) over chat.
- **Tenant isolation:** `tenant_id` on every row + Postgres RLS, derived from signed session metadata,
  never from tool arguments. One session = one tenant.
- **No raw SQL exposed to the model.** Analytics/reports use parameterized, tenant-scoped tools only.
- **Defined-purpose scope:** answer this business's accounts questions; politely decline unrelated ones.
- **Idempotency / exactly-once (finance-critical):** inbound WhatsApp/payment webhooks retry — dedupe by
  message/event id and use idempotent write keys so an entry is NEVER recorded twice. Serialize a tenant's
  messages; allocations run in one locked transaction. (Details in v2.0 §6.)
- **Roles enforced server-side:** once multi-user exists, permission checks live in the MCP tools + RLS,
  not just the prompt. Confirming entries / moving money is gated by role. (v2.0 §3.)
- **Cost is a feature:** per-tenant budgets, model routing (cheap model for trivial turns), rate limits.
  (v2.0 §7.)
- **Tax rates/deadlines are config**, not scattered literals. Verify current IRD deadline via web fetch
  before reminders. Tax facts are in v1.1 §5 — do not invent rates.

## 4. Tech stack & conventions
- TypeScript (strict, ESM), Node 20+. pnpm monorepo.
- Fastify (orchestrator/webhooks). `@modelcontextprotocol/sdk` for the MCP servers (remote HTTP/SSE).
- `@anthropic-ai/sdk` with beta header `managed-agents-2026-04-01` for Managed Agents.
- PostgreSQL 16 + drizzle + **RLS**. BullMQ + Redis for jobs. `zod` on every external input.
- Reports: render PDFs **deterministically from validated data** via HTML→PDF (Playwright); the model
  never hand-writes numbers into a document.
- Payments v1: **Khalti only (live)**; eSewa + Fonepay are "coming soon" stubs surfaced to users.
- Secrets: Managed Agents **vaults**; nothing secret in the repo or system prompt.
- `tsc --strict` clean, eslint + prettier, `vitest`. Write **tests first** for all money/VAT/TDS,
  inclusive-math rounding, aging buckets, and allocation logic — these are the highest-risk code.
- `.env.example` only; never commit real keys.

## 5. Build order (follow phases; details in the PRDs)
- **Phase 0** (v1.1): monorepo + `shared` (Money/paisa, VAT/TDS pure fns, BS-date) + **Validation Engine**,
  all with exhaustive unit tests. ← start here.
- **Phase 1**: Postgres + RLS + schema; Ledger MCP (record/validate/draft→confirm).
- **Phase 2**: agent definition + 3 skills + system prompt; create agent; orchestrator session client;
  Pre-delivery Audit Gate in the relay path.
- **Phase 3**: WhatsApp Cloud API webhook, media→Files, onboarding/pairing; submit Utility templates early.
- **Phase 4**: bill-extraction confirmation loop end-to-end (test with messy bills).
- **Phase 5**: Payments MCP (Khalti sandbox; eSewa/Fonepay "coming soon").
- **Phase 6**: monthly reminder scheduler + session self-verification.
- **Module C** (v1.2): C-1 AR/AP schema + allocation logic (+tests) → C-2 analytics + aging (+tests)
  → C-3 Reports service (HTML→PDF, reconcile-or-hold, WhatsApp document delivery) → C-4 remaining
  reports → C-5 scope guardrail.
- **Commercialization track (v2.0)** — build only AFTER piloting v1 and proving retention. Order:
  P8 identity/RBAC → P9 idempotency/concurrency → P10 billing → P11 cost controls → then P12 voice,
  P13 accounting completeness, P14 observability, P15 security, P16 infra/CI-CD, P17 growth, P18 support/
  admin, P19 accountant channel. Build the "required-for-first-paid-customer" subset (P8–P11 + minimal
  P15/P16) before charging; defer the rest until volume demands it. **Sequence beats completeness — do
  not build all of v2 up front.**

## 6. How to work with me
- Before each phase, **propose a short plan and the file list**, then wait for my OK. Don't build
  everything at once.
- Keep changes small and tested. Run the test suite before saying a phase is done.
- When you hit an external unknown (Khalti/WhatsApp/Managed Agents API specifics), check the official
  docs or ask me — don't assume API shapes.
- If you learn a durable fact about this project, you may note it to memory; keep this file lean.

## 7. How we build — three-phase workflow
Adapted from Anthropic's "How We Claude Code" workshop
(github.com/anthropics/cwc-workshops/tree/main/how-we-claude-code). Apply per feature/phase:
1. **Explore.** Before coding anything non-trivial, interview me to surface ambiguities (use the
   AskUserQuestion tool / ask focused questions) and write down the spec/decision. Don't assume scope.
2. **Plan.** Read the relevant spec, then propose the approach — for anything with real design choices,
   sketch 2+ options and trade-offs before committing. Wait for my OK.
3. **Verify.** Build so the result is **observable and provable at runtime**, not just "looks right in
   code." See §8.

## 8. Verification discipline (every unit is runtime-verifiable)
Verification = runtime observation at the surface: run it, drive it, read what it actually does. Tests
and typechecks are CI's job; verification confirms the real artifact behaves. Apply to every unit
(money/VAT/TDS fns, Validation Engine, MCP tools, report renderer):
- **Declare fixtures + invariants.** Each unit ships named, reproducible input fixtures and predicates
  that must always hold (e.g. "taxable + vat == total"; "TDS base excludes VAT"; "aging buckets sum to
  the grand total"; "report total == sum of confirmed balances").
- **At least one adversarial PROBE per unit.** A fixture designed to be *wrong* that the unit MUST catch
  (e.g. a ledger where balances don't reconcile, a 17Ka bill claimed for input credit, a duplicate
  invoice). A unit with no probe has only tested the happy path — not allowed. Prove it catches lies.
- **Stable contract, not internals.** Verify observable outputs (the returned result object / the PDF
  totals / the validation verdict), so internals can be refactored freely.
- **One verdict taxonomy, shared by human + agent + CI:** `PASS | FAIL | BLOCKED | SKIP`. The same code
  path produces the verdict whether a person, the agent, or `vitest` runs it.
- **BLOCKED ≠ FAIL.** "Couldn't observe/verify" (BLOCKED) is distinct from "observed and wrong" (FAIL).
  **When in doubt, do not pass** — for this product that means **hold + ask the owner** (the Audit Gate),
  never assert. A false PASS ships a wrong number to a business; a false FAIL just costs one more look.

## 9. First task
Set up the pnpm monorepo and Phase 0 `shared` package: `Money` (paisa) utilities, the VAT and TDS
pure functions (rates from v1.1 §5), the BS↔AD date helper (pinned `nepali-date-converter`), and the
Validation Engine — each with a thorough `vitest` suite (VAT inclusive/exclusive rounding, 13% check,
totals reconciliation, 1-year input-credit window, Rule 17Ka ineligibility, TDS-excludes-VAT, duplicate
detection, aging-bucket boundaries). Per §8, each unit must include at least one **adversarial probe**
fixture that is designed to fail (e.g. a non-reconciling total) and that the code must catch. Propose
the package structure and the test/fixture list (happy paths + probes) first, then implement.
