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
- **Subscription billing (P10):** the SMB pays HisabKitab via 3 fixed tiers — Starter **Rs 2,999** /
  Pro **Rs 4,999** / Business **Rs 7,999** per month (prepaid). Prices are config in ONE place
  (`packages/mcp-payments/src/plans.ts`, integer paisa); the landing `/pay` page mirrors them. Tools
  `list_subscription_plans` + `initiate_subscription` (price comes from the plan, never the caller; same
  `owner_approved` consent gate). **Default DEV mode = no charge / no Khalti call**; set `PAYMENTS_LIVE=1`
  (real merchant key) to enable live charging after deploy.
- Secrets: Managed Agents **vaults**; nothing secret in the repo or system prompt.
- `tsc --strict` clean, eslint + prettier, `vitest`. Write **tests first** for all money/VAT/TDS,
  inclusive-math rounding, aging buckets, and allocation logic — these are the highest-risk code.
- `.env.example` only; never commit real keys.

## 4a. Running the app with Docker (preferred — one command)
The whole backend runs in Docker Compose. **Do not run services by hand** for an end-to-end check; use Compose.
- **Dev (build + run everything, ports published):**
  `docker compose -f compose.yaml -f compose.dev.yaml up --build`  (or `pnpm up`)
  Brings up Postgres 16 (+ RLS roles via `infra/postgres/init`), Redis, a one-shot `migrate` job
  (applies `packages/db/migrations`), then ledger (:8801), payments (:8802), orchestrator (:8810).
  Each service serves `GET /healthz` (and `/livez`); Compose gates start-up on those healthchecks.
- **Stop:** `pnpm down`  ·  **detached:** `pnpm up:detached`.
- **Prod (single VM):** `docker compose -f compose.yaml -f compose.prod.yaml up -d` — pulls SHA-tagged
  images from GHCR (`ghcr.io/<owner>/hisab-<service>`), localhost-only ports behind a TLS reverse proxy,
  resource limits. The CD workflow does this over SSH.
- **One Dockerfile, parameterized:** `docker build --build-arg SERVICE=mcp-ledger .` (or `orchestrator`/
  `mcp-payments`). Multi-stage, non-root `hisab` user, tini init, runs via `tsx` (precompile-to-JS +
  distroless is a documented future optimization in `docs/DEPLOY.md`).
- **Browse the DB in the browser:** `pnpm db:studio` → open https://local.drizzle.studio (Drizzle Studio;
  inspect only — hand-written SQL migrations remain the source of truth, not drizzle-kit push).
- **Gotcha (fixed, keep it):** service entrypoints use `pathToFileURL(process.argv[1])` for the
  is-direct-run check. The old hand-built `file:///${path}` produced four slashes on Linux, so the server
  silently never started in a container (exit 0, no logs). Never reintroduce that pattern.
- Full deploy runbook + secrets list: `docs/DEPLOY.md`.

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

## 5a. BUILD STATUS — what's done, what's pending (keep this current!)
> To continue work: read this file, then **build the next ⬜ PENDING item below**. The user may also
> just say a phase number/name. Always propose the plan + file list first (§6), build small, test, and
> run the suite before calling it done. Update this checklist when a phase lands.

**✅ DONE (committed; 276 tests green, real-API verified on Sonnet incl. Module C live 8/8):**
- ✅ **Phase 0** — `shared`: Money/paisa, VAT/TDS, BS-date, **aging pure fns**, Validation Engine (+ probes).
- ✅ **Phase 1** — Postgres + RLS + schema; Ledger MCP (record/validate/draft→confirm).
- ✅ **Phase 2** — agent definition + 3 skills + system prompt; session client; Pre-delivery Audit Gate.
- ✅ **Phase 3** — WhatsApp webhook (signed), media→Files, onboarding/pairing, Utility templates.
- ✅ **Phase 4** — bill-extraction confirmation loop end-to-end (8 adversarial bills + real photo).
- ✅ **Phase 5** — Payments MCP (Khalti live + eSewa/Fonepay "coming soon"); agent wired; 4th skill.
- ✅ **Phase 6** — BullMQ monthly reminder scheduler + independent session self-verification.
- ✅ **Phase 7** — hardening: credential-scrub guard, tenant data-deletion path, rate-limit + retry/backoff.
- ✅ Extras: model is config (`HISAB_MODEL`, dev=Sonnet/prod=Opus); commit-guard hook (`.claude/`);
  marketing **landing page** (`landing/`, Next.js); `pnpm dev` runs the whole stack.

**✅ Module C (v1.2) — reports & analytics — DONE (2026-06-14; +31 tests = 276 total; live-verified 8/8):**
- ✅ **C-1** AR/AP schema (migration 0007: parties/ar_invoices/ap_bills/party_payments/payment_allocations
  + RLS + grants, mirroring 0001/0003) + recording tools (record_credit_sale/purchase, record_party_payment,
  confirm_arap_entry) with draft→confirm. Allocation logic is a pure `@hisab/shared/allocation` module
  (auto oldest-first + manual; over-allocation rejected); balances decrement in ONE locked tx
  (SELECT…FOR UPDATE) — exactly-once concurrency probe passes.
- ✅ **C-2** analytics tools (get_receivables_summary/payables_summary/statement/sales_summary/top_parties),
  aging via the Phase-0 pure fn + independent reconcile re-verify.
- ✅ **C-3/C-4** Reports service in the orchestrator: deterministic **Tally-grade PDF via pdfmake@0.2**
  (branded header, summary cards, zebra table + bold totals, ageing matrix, statutory footer) — chose
  pdfmake over Playwright (no Chromium download; user-approved). reconcile-or-hold Audit Gate
  (PASS|FAIL|BLOCKED), WhatsApp document delivery (WaClient.sendDocument/uploadMedia). All four report
  types (receivables/payables/statement/sales_summary). Agent wired: `request_report` ledger tool →
  captured in runTurn → dispatched after the turn (reports/dispatch.ts) over the real MCP.
- ✅ **C-5** scope guardrail — already in the system prompt; live-verified (declined "who is the PM?").
- New skill **accounts-reports** (5th skill); REPORTS paragraph in system prompt. Scripts:
  `verify:reports` ($0, 4/4 over real MCP HTTP), `verify:reports-live` (real agent E2E, 8/8), `reports:sample`.
  Generated PDFs in gitignored `packages/orchestrator/report-samples/`.

**✅ P9 (v2.0 §6) — idempotency & concurrency — DONE (2026-06-15; +13 tests = 289 total):**
- v1 already had: inbound WhatsApp dedupe (`wa_events` PK), per-tenant serialization (`SerialQueues`),
  exactly-once allocation (`confirmPayment` SELECT…FOR UPDATE), Khalti callback dedupe (`pidx` UNIQUE +
  `sale_id` latch). The gap was the §6 **idempotent write key on entry-creating tools** — now built.
- Migration **0008**: `idempotency_keys` (PK **(tenant_id, scope, key)** — composite, NOT the PRD's global
  `key`, so one tenant's literal key can't collide with another's) + RLS + `hisab_app` grant.
- Pure DRY core `withIdempotency` + `IdempotencyStore` in `@hisab/shared` (load→produce-once→save, replay
  flag); drizzle-backed `txIdempotencyStore` (ON CONFLICT DO NOTHING, never aborts the tx). Optional
  `idempotency_key` wired into all 5 entry-creating tools (record_sale/expense/credit_sale/credit_purchase/
  party_payment) — backward-compatible (no key = old behaviour). A retry returns the original result, never
  a 2nd row. 6 shared unit + 7 ledger contract tests incl. probes (race, tenant-scoping). Root `pnpm test`
  made sequential (`--workspace-concurrency=1`) so the shared-test-DB reset no longer races.

**✅ P16 (v2.0 §10) — Docker + CI/CD + landing-live — DONE (2026-06-15; 292 tests, +3 health):**
- **Dockerized all 3 services** via ONE parameterized multi-stage `Dockerfile` (`--build-arg SERVICE=`),
  non-root `hisab` user, tini, runs through `tsx`. `/healthz`+`/livez` added to ledger & payments (raw http)
  and orchestrator (Fastify); 3 health tests. **Root-caused + fixed a cross-platform bug**: `isDirectRun`
  used `file:///${argv1}` (4 slashes on Linux) so ledger/payments/**migrate** silently never started in a
  container — switched all to `pathToFileURL`. `loadConfig` now boots without `agent-ids.local.json`.
  `@types/node` made an explicit dep in all 5 packages (was only hoisted; container typecheck failed).
- **Docker Compose dev + prod** (`compose.yaml` + `compose.dev.yaml`/`compose.prod.yaml`): Postgres
  (+ RLS roles via `infra/postgres/init/00-roles.sql`) + Redis + one-shot `migrate` + 3 services, healthcheck
  gated. Verified live: full stack healthy, 8 migrations applied incl. 0008, `idempotency_keys` RLS on.
  Root scripts `pnpm up` / `down` / `up:detached`. **Drizzle Studio**: `pnpm db:studio` → local.drizzle.studio.
- **CI** (`.github/workflows/ci.yml`): typecheck + lint + full vitest (PG+Redis service containers + roles),
  build all 3 images (matrix) + boot/healthz smoke, Trivy scan. Public AND private safe.
- **CD** (`.github/workflows/cd.yml`): build+push SHA-tagged images to GHCR (provenance+SBOM), then SSH
  deploy to the single prod VM via `compose.prod.yaml` (compose pull + up, healthcheck-gated zero-downtime).
  **Deploy job is DORMANT until `DEPLOY_HOST`/`DEPLOY_SSH_KEY` secrets exist** — "coming soon" today, goes
  live the moment those are set (target: Tencent Cloud VM). K8s/ArgoCD/Terraform deferred (single VM is simpler).
- **Landing live** on **hisabkitab.pro** via GitHub Pages (`.github/workflows/landing-pages.yml`, static
  export + CNAME + .nojekyll). Content de-risked: removed "Claude Managed Agents" + invented testimonials +
  over-claims ("never guesses"/"zero mistakes"), removed ALL em-dashes (anti-AI-look). **SEO**: JSON-LD
  (Org/WebSite/SoftwareApplication/FAQ), robots+sitemap+manifest (force-static), OG/Twitter, canonical, OG
  image. New **/pay** Khalti dev-preview page (catchy, disabled button, cannot charge → $0).
- DNS (Namecheap): 4× A `185.199.108-111.153` + CNAME `www→nikegunn.github.io` (GitHub Pages) — verified
  resolving. GitHub user: **NikeGunn**. Deploy runbook: `docs/DEPLOY.md`.

**✅ P10 — FULL billing lifecycle — DONE (2026-06-15; 332 tests, +34):**
- **Plans** (Starter Rs 2,999 / Pro Rs 4,999 / Business Rs 7,999, prepaid monthly). Canonical name+price
  now in `@hisab/shared` `PLAN_META` (single source of truth); `mcp-payments/plans.ts` composes blurb+
  feature copy on top; landing `/pay` mirrors. Integer paisa throughout.
- **Migration 0009**: `subscriptions` (one per tenant, status trial|active|past_due|suspended|cancelled,
  `current_period_end`, `last_dunned_stage/for` latch) + `billing_payments` (the tenant paying US; `pidx`
  UNIQUE exactly-once). Tenant RLS + `hisab_app` grant + `hisab_orch` orch_all (callback + dunning are
  cross-tenant), mirroring 0003.
- **Pure lifecycle in `@hisab/shared/billing`** (highest-risk, fully unit-tested + probes): `startTrial`,
  `projectStatus` (time-aware: grace boundary exact, NEVER silent reactivation), `renew` (prepaid month,
  extends from later of {end, today} so a post-lapse payment grants no free days; cancelled can't renew),
  `dunningDecision`. `@hisab/shared/billing/features` = `planAllows`/`planSeats`/`minPlanFor` feature-gating.
- **Tools** (payments MCP): `start_trial` (idempotent), `get_subscription_status` (projects the live status,
  not the stale row), `initiate_subscription` (→ `billing_payments` in live mode, dev mode no-charge),
  `verify_subscription` (settles by Khalti lookup, extends period exactly-once, returns a RECEIPT),
  `cancel_subscription` (owner_approved; access until period end; data retained). `settleSubscriptionPayment`
  in `billing.ts`; the Khalti return-URL callback now settles BOTH collections and subscriptions by pidx.
- **Dunning** (orchestrator `scheduler/dunning-job.ts`, runs in the SAME daily BullMQ tick as reminders):
  scans subscriptions, sends `subscription_due_soon`/`_expired`/`_suspended` Utility templates, advances
  status, **auto-suspends after grace (never deletes data)**. Latched on `(last_dunned_stage, period_end)`
  so a daily pass never double-sends/double-suspends — same at-least-once + DB-latch design as reminders.
- Tests: shared 124 (+23 billing/features), payments 32 (+6 lifecycle incl. replay-exactly-once + consent
  probes), orchestrator 127 (+5 dunning incl. auto-suspend + latch + no-number probes). Verified live in
  the Docker stack (0009 migrates, subscriptions/billing_payments RLS on). Still DEV-safe until deploy +
  `PAYMENTS_LIVE=1` + real Khalti merchant key.

**✅ P11 (v2.0 §7) — cost controls — DONE (2026-06-16):** protects unit economics + stops abuse.
- **Model routing / trivial short-circuit** (`@hisab/shared/cost/routing.ts`, pure): a trivial turn
  ("ok"/"thanks"/धन्यवाद/bare 👍) is answered LOCALLY with a canned reply — **no agent session, no model
  call** (biggest saver). DELIBERATELY conservative: any digit / unknown word / >4 tokens / attached media
  ⇒ substantive (never misroute a money message). `pickModel(intent)` documents the cheap-vs-money split.
- **Per-tenant monthly budgets** (`@hisab/shared/cost/budget.ts`, pure): `projectBudget(plan, usage)` →
  `OK | WARN(≥80%) | THROTTLE(≥cap)`; per-plan caps in ONE place (`PLAN_BUDGET_PAISA`, integer paisa,
  Starter Rs 500 / Pro Rs 1,200 / Business Rs 3,000). `estimateCostPaisa(model, tokens)` rounds UP; unknown
  model → most-expensive rate (can't sneak past). Unknown plan → strictest (starter) cap (deny-by-default).
- **Usage accounting** — migration **0013** `usage_counters` (PK `(tenant_id, period)`, monotonic
  turns/tokens/cost_paisa + `warned_at` latch) + RLS (tenant read for the tool; orch_all for the recorder)
  + grants (app SELECT; orch S/I/U/**D** for the GDPR purge). `@hisab/db` `recordUsage` (atomic upsert
  `+=`), `getUsage`, `markWarned` (once-per-period latch), `getTenantSpend` (dashboard). Purged on deletion.
- **Wired server-side** in the router (NEVER the prompt): trivial → canned reply + count; pre-turn
  `checkBudget` (THROTTLE = backpressure, never data loss, friendly "resets next month / upgrade"; WARN =
  serve + one-time nudge); post-turn token usage recorded from the stream's `span.model_request_end`
  events (summed in `runTurn`). New read-only **`get_cost_summary`** ledger tool (verdict + NPR figures).
- Tests: shared cost-routing + cost-budget pure units (+ probes: no-misroute, cap boundary, unknown-model);
  DB usage-counters contract (atomic-race probe, warn latch); router cost integration (trivial never starts
  a turn, throttle blocks pre-turn); ledger get_cost_summary contract (+ THROTTLE + viewer-role probes).

**✅ Audit-log hash-chain (v2.0 §9) — DONE (2026-06-16; 424 tests, +13):** tamper-evident SINGLE
SOURCE OF TRUTH so the agent/owner record can't be silently rewritten. Each `audit_log` row carries
`prev_hash` + `row_hash` = SHA-256(prev_hash + canonical(row)), chained per tenant from a genesis hash.
- Pure core in `@hisab/shared/audit` (`hashAuditRow`, deterministic `canonicalize`, `verifyAuditChain`)
  + 7 probes (edit/delete/insert/reorder/genesis-tamper all caught). Migration **0012** adds the 2 columns
  + `(tenant_id,id)` index (nullable → pre-chain rows stay valid).
- `appendAudit(tx, tenantId, {actor,action,detail})` in `@hisab/db` is now the ONE way to write an audit
  row (per-tenant `pg_advisory_xact_lock` so concurrent appends can't fork the chain). ALL ~15 audit
  write-sites (ledger/arap/payments/billing/orchestrator gate+pairing+membership+router+main) route
  through it. New **`verify_audit_chain`** ledger tool (read-only) → PASS|FAIL with the broken index;
  3 DB-level tamper-detection contract probes (edit + delete caught live). `@hisab/db` now depends on
  `@hisab/shared` (no cycle — shared is pure).

**✅ Idempotency race fix (v2.0 §6) — DONE (2026-06-15):** claim-first ordering (reserve the key BEFORE
producing) so two truly-concurrent same-key calls serialize on the unique index — only the winner produces.
Migration **0011** grants UPDATE on idempotency_keys (finalize). Was an intermittent CI flake; now 8/8 stress runs green.

**✅ Web-verification governance (v1.1 §5 / v2.0 §9) — DONE (2026-06-15; +9 tests):**
- The agent already ships the built-in toolset (`bash`/files/`web_search`/`web_fetch`); this GOVERNS it
  for zero-fabrication. Web is read-only + single-purpose (confirm the IRD deadline/rate ONLY; scope
  guardrail forbids general browsing). **Web confirms, never overwrites**: a web value can never become a
  saved entry or a sent figure on its own — the deterministic engine is the only source of truth.
- Pure `checkFilingDeadline` in `@hisab/shared` (PASS=web-matched / SKIP=not checked / BLOCKED=disagree or
  unreadable → HOLD, never adopt the web value) + 5 probes. New **`verify_filing_deadline`** ledger tool
  (read-only, `generate_report` cap): returns the COMPUTED deadline + verdict + guidance, audit-logs source
  + verdict; 4 contract probes incl. "bogus web date BLOCKS and is never adopted". System prompt WEB CHECKS
  paragraph + definition test locks it in. Egress allowlist deferred to scale-time (documented in v2.0 §9).

**✅ P8 (v2.0 §3) — identity, multi-user & RBAC — DONE (2026-06-15; 402 tests, +70):**
- **Migration 0010**: `users` (global WhatsApp identity) + `memberships` (user↔tenant role + invite
  lifecycle invited|active|revoked). Partial-unique `(user,tenant) WHERE status<>'revoked'` (revoked
  doesn't block re-invite) + `(tenant,status)` / `(user)` indexes. RLS: memberships tenant-scoped for
  hisab_app (read-only seat lookups) + orch_all for hisab_orch; users is global (orch-only). hisab_orch
  gets DELETE (it runs the GDPR purge). **Set-based backfill**: one owner user+membership per existing
  active tenant, so all current sessions resolve as owner unchanged.
- **Pure RBAC core in `@hisab/shared/rbac`** (single source of truth, fully unit-tested + probes): the
  PRD §3 capability matrix packed as per-role **bitmasks** → `can(role,cap)` is one O(1) bitwise-AND;
  `assertCan`/`RoleError`; deny-by-default (unknown role ⇒ mask 0 ⇒ refused everything).
- **Role travels in the signed session token** (`auth.ts`): `createTenantToken(tenantId, secret,
  {role,userId,ttl})`; `verifyTenantToken` → `{tenantId, role, userId}`, **default owner** for pre-P8
  tokens (back-compat). A forged/tampered role breaks the HMAC; a present-but-unknown role is rejected,
  never silently downgraded. The vault bearer is rotated per turn to carry the resolved role.
- **Server-side enforcement** (deny-by-default, NEVER the prompt): one `TOOL_CAPABILITY` map per service
  (`Record<keyof inputSchemas, Capability>` so TS forces every new tool to declare one); the registration
  wrapper calls `assertCan(role, cap)` BEFORE the handler. Money/refund + billing are owner-only — the role
  gate fires before the `owner_approved` consent gate, so a lower role can never charge. Contract tests over
  real MCP HTTP prove staff can't confirm, viewer can't record, accountant can't move money, owner passes.
- **WhatsApp invite flow** (FAANG-grade, no misuse): identity is the VERIFIED webhook sender (never message
  text); `inviteMember` is owner-only (checked server-side); the invitee gets ONLY the offered role and must
  text "JOIN" from **its own** number to accept (no self-escalation); owners can grant accountant/staff/
  viewer (never owner); re-invite is idempotent; every change audit-logged. Pairing now also creates the
  owner user+membership; `deleteTenantData` purges memberships + orphaned-only users (a shared accountant
  serving other tenants keeps their identity). Tests incl. probes for each.

**⬜ PENDING — build in this order:**
- ⬜ **Commercialization (v2.0) — build ONLY after a v1 pilot proves retention.** Required-for-first-
  paid-customer subset: ✅ **P8** identity/RBAC (DONE) → ✅ **P9** idempotency → ✅ **P10** billing (DONE) →
  ✅ **P11** cost controls (DONE) → minimal ⬜ **P15** security → ✅ **P16** infra/CI-CD (DONE).
  Defer until volume: ⬜ P12 voice, ⬜ P13 accounting completeness, ⬜ P14 observability, ⬜ P17 growth,
  ⬜ P18 support/admin, ⬜ P19 accountant channel.

**🌐 EXTERNAL (not code — needed before a real pilot):** Meta business verification + WhatsApp number
+ webhook registration; Khalti **merchant onboarding** (sandbox `test-admin.khalti.com`; prod needs the
MOU docs); a **Redis** instance (scheduler); public **https deploy** of the Ledger + Payments MCP
servers. Details in the gitignored `manual.txt`.

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
