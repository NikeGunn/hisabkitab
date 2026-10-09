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
  `owner_approved` consent gate). **Default DEV mode = no charge / no Khalti call**. Going live is a
  **runtime setting, not a deploy**: admin panel → Settings → Payments (Khalti key, environment
  `https://khalti.com`, billing live = true). `PAYMENTS_LIVE`/`KHALTI_*` env are only defaults.
- **Runtime settings (0019):** WhatsApp sender/token/secrets, Khalti key/env/live, signup controls live in
  `app_settings` (secrets AES-GCM via `FIELD_ENCRYPTION_KEY`), resolved admin → env → default by the pure
  registry `@hisab/shared/settings/registry.ts` (add new operator-editable config THERE, one place).
  Orchestrator + payments hot-reload within 10s. Never read these via `process.env` in new code.
- **Model (pilot):** `claude-sonnet-4-6` at effort **low** (`HISAB_MODEL`, `HISAB_EFFORT`), user decision
  2026-10-05 to keep pilot cost down. Correctness never depends on the model: figures come from ledger
  tools + the Audit Gate.
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
- **CI/CD contract:** branch protection requires ONLY the aggregate `ci-ok` check (ci.yml); jobs are
  change-aware (`changes` → backend/landing) so never add per-job required checks. Dependabot: weekly
  grouped minor/patch + grouped security PRs auto-merge on green; npm MAJORS are not opened — they're
  listed (with a full OSV vuln scan) on the weekly "Dependency dashboard" issue and upgraded by hand.
  Transitive vulns: fix with a same-major `pnpm.overrides` entry. `landing/` is its own pnpm
  workspace (landing/pnpm-workspace.yaml) with self-hosted fonts (no network at build).

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

**✅ DONE (committed; 720 tests green as of 2026-10-05; real-API verified on Sonnet):**
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

**✅ P15 (v2.0 §9) — security & compliance (minimal required subset) — DONE (2026-06-16):** the
last required-for-first-paid-customer item. (Hash-chain, RBAC, web-governance, deletion, secrets-
in-vaults were already done; this closes the remaining gaps.)
- **Field-level PII encryption** for PAN/VAT (most sensitive PII): pure `@hisab/shared/crypto`
  AES-256-GCM, **authenticated** (tamper/wrong-key fail closed, never silent garbage), versioned
  self-describing ciphertext (`enc:v1:iv:tag:ct`) so a column holds a mix during rollout. Key from
  `FIELD_ENCRYPTION_KEY` (32B base64, secret manager); **unset in dev/test ⇒ plaintext** (back-compat,
  nothing breaks). `@hisab/db` `encPII`/`decPII` (process-cached key) wired at the 3 sites: vendors +
  parties PAN (encrypt on write / decrypt on read in the ledger tools) + tenant PAN (decrypt on read
  in reports). PAN is never a query key, so zero query impact. Compose passes the key to ledger +
  orchestrator. Tests: 16 pure (roundtrip, random-IV, tamper/wrong-key/malformed/short-key probes,
  dev passthrough) + 4 ledger contract (stored ciphertext, plaintext-never-in-DB probe, dev mode).
- **Legal + auditor disclaimer:** `docs/legal/{TERMS,PRIVACY,DATA-PROCESSING}.md`; the
  "assistance, not a substitute for a licensed auditor / no statutory sign-off" disclaimer is an
  exported `AUDITOR_DISCLAIMER` constant **surfaced in the paired (signup) welcome** + a definition test.
- **Incident-response + DR runbook:** `docs/INCIDENT-RESPONSE.md` (breach / data-loss / wrong-filing
  playbooks, secret-rotation order, hash-chain as source of truth) + backups/PITR/retention + RPO≤15m /
  RTO≤2h targets, also summarized in `docs/DEPLOY.md §5`. Full secret-rotation automation + at-rest
  infra encryption + tested PITR restore remain scale-time (documented).

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

**✅ P13 (v2.0 §12) — accounting completeness (CORE) — DONE (2026-06-17):** the two highest-value,
correctness-oriented, fully-offline-testable pieces.
- **Sequential VAT invoice numbering** (IRD Rule-17, gap-free per BS fiscal year): migration **0014**
  `invoice_sequences` (PK `(tenant_id, fiscal_year)`) + RLS + `hisab_app` grant. Pure `bsFiscalYear`/
  `bsFiscalYearLabel` in `@hisab/shared` (Shrawan–Ashadh; month≥4 ⇒ FY=year, else year−1). New
  **`next_invoice_number`** ledger tool allocates under `last_number = last_number + 1 RETURNING`
  (Postgres serializes on the row) so concurrent allocations never reuse/skip — 12-way race probe gives
  exactly 1..N. Series resets each FY. Number format `"<FY label>-<4-digit seq>"` e.g. `2082/83-0007`.
- **Credit / debit notes** (never edit a confirmed invoice): migration **0014** `credit_notes`
  (FK→`ar_invoices`, draft→confirmed) + RLS + grant. Pure `computeNote` in `@hisab/shared/accounting`
  (a CREDIT note can't exceed the original; VAT must be coherent with the taxable base within 1-paisa;
  negatives/zero rejected) + 9 probes. New **`issue_note`** (refuses a DRAFT original; recomputes VAT,
  never hand-entered; allocates a note number from the same series) + **`confirm_note`** ledger tools.
  Capabilities: numbering/note draft = `record_entry`, confirm = `confirm_entry` (viewer-denied probe).
- accounts-reports SKILL got a "Corrections & sequential invoice numbers" section; landing Platform page
  got an "Invoices & corrections" section. Tests: shared +7 (bsFiscalYear boundary) +9 (notes) = 239;
  ledger +1 file (`accounting.contract.test.ts`: gap-free, FY-reset, concurrency, over-credit, draft-
  reject, debit, RBAC probes).

**✅ P13 (v2.0 §12) — accounting completeness (REMAINDER) — DONE (2026-06-19; 548 tests, +44):** the
four deferred pieces, pure-logic-first with adversarial probes, reusing the proven scheduler/ledger rails.
- **TDS deposit reminder** (due the 25th, same cutoff as VAT): pure `tdsDepositDeadline` in `@hisab/shared`
  (reuses `vatFilingDeadline`, intent-named). New **`generate_tds_summary`** ledger tool totals confirmed
  `expenses.tds_paisa` for a BS month + returns the deposit deadline (read-only, `generate_report`). New
  scheduler pass `runTdsReminderPass` (`tds-reminder-job.ts`) runs in the SAME daily BullMQ tick after the
  VAT reminder, INDEPENDENTLY self-verifies the figure (re-totals the column), and sends a `tds_due_soon`
  Utility template: PASS states the figure, FAIL/BLOCKED sends figure-free, NIL is SKIPPED. Exactly-once on
  `reminder_log (tenant,year,month,'tds_due_soon')` (migration **0015** widens the kind CHECK). Wired in
  `main.ts` via `createTdsSummaryProvider`.
- **Opening balances** (accurate reports from day one): migration **0015** `opening_balances` (receivable/
  payable/vat_credit; `opening_party_shape` CHECK forces a party iff debtor/creditor) + RLS + app grant +
  orch SELECT/DELETE (GDPR purge). Pure `computeOpening` in `@hisab/shared/accounting` (positive bigint
  paisa, ISO date, kind) + 8 probes. New **`record_opening_balance`** (draft, party-shape enforced) +
  **`confirm_opening_balance`** ledger tools. Purged in `data-deletion.ts`.
- **Backdated entries**: pure `assignBsPeriod` in `@hisab/shared/accounting` (derives the BS period + FY
  from `occurred_on`; flags backdated when the occurrence month < recording month; REFUSES a future date)
  + probes. `sales`/`expenses` get an `is_backdated` column (migration **0015**, default false); wired into
  `record_sale`/`record_expense` (returns `is_backdated` + a `backdated_note` telling the owner which return
  to re-summarize). Self-verify already keys off `occurred_on`, so recompute is automatic.
- **Fiscal-year carry-forward & annual summary**: pure `annualVatSummary`/`settleMonth` in
  `@hisab/shared/accounting/annual` (rolls excess VAT credit forward month-to-month per Sec 17/24; annual
  net = Σ monthly net; rejects a garbled year) + 11 probes. New **`get_annual_summary`** ledger tool
  (read-only) aggregates the 12 BS months from confirmed entries, seeds the opening carry from a confirmed
  `vat_credit` opening balance, returns per-month settlement + annual totals + closing carry-forward.
- Tests: shared +10 (annual/opening/backdate/tdsDeadline), ledger +1 file `accounting2.contract.test.ts`
  (TDS summary, opening party-shape + RBAC probes, annual empty + carry-seed, backdate flag + future-reject),
  orchestrator +1 file `tds-reminder.test.ts` (PASS-with-figure, exactly-once, nil-skip, lying-figure HOLD,
  tenant selection). accounts-reports SKILL + system prompt RETURNS/CORRECTIONS paragraphs updated; landing
  Platform page +4 sections and home Features grid +3 tiles (catchy, no em-dashes). All 548 tests green,
  typecheck + lint clean, landing builds. Verified on a CI-equivalent Postgres 16 + Redis stack locally.

**✅ Compliance-calendar mechanism (zero-hallucination, wired to Managed Agents) — DONE (2026-06-20;
572 tests, +24):** the proactive "agent gets notified under the hood" digest. Once per BS month each
active tenant with a bound number gets ONE figure-free "what's due this month" digest from the
deterministic calendar engine (statutory VAT/TDS deadlines + the tenant's own open invoice/bill due
dates) — additive to the figure-specific VAT/TDS reminders.
- Pure `computeComplianceCalendar` in `@hisab/shared/calendar` (statutory dates + DueItems → sorted
  `CalendarEvent[]` with `daysUntil`; never fabricates a holiday) + probes; migration **0016**
  `0016_calendar_notice.sql` widens the `reminder_log` kind CHECK with `'deadline_digest'`.
- Scheduler pass `runCalendarNoticePass`/`noticeTenant` (`calendar-notice-job.ts`) runs in the SAME
  daily BullMQ tick; exactly-once on the `reminder_log (tenant,year,month,'deadline_digest')` latch
  (claim-first, send-then-keep, delete-on-send-fail). Figure-free ⇒ no self-verify. New `deadline_digest`
  Utility template. Wired in `main.ts` via the `calendar` scheduler dep.
- Zero-hallucination: every date comes from the engine; the scheduler never formats a date it computed
  itself. Tests: shared calendar units + orchestrator `calendar-notice.test.ts` (figure-free digest,
  exactly-once probe, tenant selection / unbound-number skip). Fixed the shared-test-DB `beforeEach`
  cleanup to purge FK-child tables (`subscriptions`/`billing_payments`/`deletion_log`) other files leave.

**✅ Meta WhatsApp Cloud API — LIVE webhook registration (no-dashboard) — DONE (2026-06-20):** real
test number `+1 555-673-7959` (Phone ID `1207406082449839`, WABA `935012972908181`, App `HISABKITAB`
ID `1505059784444619`) wired end-to-end against the REAL Graph API.
- All 6 WA creds in GitHub secrets + local `.env` (gitignored): `WA_APP_ID`, `WA_APP_SECRET`,
  `WA_ACCESS_TOKEN` (never-expire system-user token), `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`,
  `WA_WEBHOOK_VERIFY_TOKEN`. New **`.github/workflows/wa-webhook-register.yml`** registers the webhook
  ENTIRELY from secrets (no Meta UI): `POST /{app-id}/subscriptions` (callback_url+verify_token, app
  access token = `app-id|app-secret`) + `POST /{waba-id}/subscribed_apps`, with a pre-flight handshake
  probe. Run: `gh workflow run wa-webhook-register.yml -f callback_url=https://<public>/webhook`.
- Verified LIVE this session: real verify-token handshake (200), valid-HMAC POST (200), forged sig
  (401), wrong token (403); registered the real webhook via cloudflared tunnel → Meta `{"success":true}`,
  WABA linked, subscription `active`. Inbound→outbound proven (real Graph send hit only `131030 recipient
  not in allowed list`, the expected test-number gate). REMAINING manual (Meta has no API, anti-spam):
  add your phone to the test number's allowed recipients + (later) submit the HisabKitab Utility templates.

**✅ P14 (v2.0 §8) — observability & reliability (Tier 1) — DONE (2026-06-28; 597 tests, +25):**
the pure-code, zero-new-infra core that makes the first pilot DEBUGGABLE the moment a
message arrives. (Tier 2 circuit-breakers/DLQ + Tier 3 canary/SLO-paging deferred to deploy.)
- **Pure `@hisab/shared/obs`** (fully unit-tested + adversarial probes): structured JSON
  `Logger` (levels, `child()` field threading, injectable sink → testable, stdout in prod);
  **secret redaction** (`redact.ts`: bearer/PAN/VAT/OTP/api-key shapes scrubbed deep through
  any value — closes the §9 "no secret in logs" gap, ONE ruleset reused by logger + audit
  preview); `MetricsRegistry` (Counter monotonic + Histogram with cumulative `le` buckets,
  Prometheus **text exposition**); `bindMetrics`/`METRIC` canonical §8 instrument catalog +
  `metricsResponse` (framework-agnostic `/metrics` body — DRY across raw-http + Fastify).
- **`GET /metrics`** on all 3 services (orchestrator Fastify + ledger/payments raw http),
  aggregate low-cardinality only (never a tenant id/phone/body). Structured boot logs replace
  the ad-hoc `console.log`s.
- **correlation_id threaded** WhatsApp msg → router → turn → MCP: one id per inbound message
  (the `wa_message_id`) via `orchestrator/src/obs.ts` `inboundCtx`; child-logger tags every
  downstream line `{correlation_id, tenant_id, role}`; forwarded to the ledger MCP as
  `x-correlation-id`. Instruments wired at the spine: inbound counter, **audit-gate hold rate**
  (the headline §8 metric, counted at the single gate point in `runTurn`), turn-latency
  histogram + outcome counter, gateway calls (Khalti), scheduler-pass result, error-by-component.
- Tests: shared +24 (logger/redact probes — a PAN/bearer/OTP NEVER reaches the sink; metrics
  format exact, monotonic-counter probe, label escaping); orchestrator +1 (`GET /metrics`
  Prometheus + correlation-id propagation assertion). All 597 green, typecheck + lint clean,
  landing builds.

**✅ Inbound crash containment (reliability audit) — DONE (2026-07-06; 600 tests, +3):** closed the
one real at-least-once gap in the message spine. The webhook ACKs Meta 200 immediately, so Meta never
retries — yet the `wa_events` dedupe row was claimed BEFORE processing, so any crash after the claim
(Anthropic outage, session-create failure, turn crash) silently swallowed the owner's message forever.
- Router now mirrors the schedulers' claim-first/release-on-fail: every user-visible reply goes through
  a `send()` tracker; on a crash with ZERO deliveries the claim is **released** (DELETE the wa_events
  row — migration **0017** grants hisab_orch DELETE) and the owner gets `PROCESSING_FAILURE_REPLY`
  ("nothing was saved, please resend"). A crash AFTER something was delivered keeps the claim (re-running
  a turn that already spoke to the owner risks double side effects — the worse failure). Crash counted
  as `inbound-crash` error metric.
- `SerialQueues` now **evicts settled tails** (`q.size` drains to 0) — the per-sender map no longer grows
  unbounded over a long-running orchestrator. Probes: crash-before-reply releases claim + apologizes +
  same-id redelivery is NOT false-deduped; pre-agent crash path same; queue-drain leak probe.

**✅ TallyPrime read-only integration (Phase T1) — DONE (2026-07-10; simulator-verified):**
"ask your Tally over WhatsApp" — pull-only, no writes possible by construction. New
`@hisab/shared/tally` (digit-exact paisa parse, negative-is-debit sign convention, payload
schemas, independent reconciliation opening+credits−debits=closing & Σbills=total, deterministic
ledger-ambiguity resolver), migration **0018** (`tally_connectors`/`tally_companies`/`tally_jobs`
+ RLS + allowlist CHECK), new service **`packages/mcp-tally`** (:8803 — 7 typed tools:
tally_connect/status/list_companies/bind_company/search_ledgers/get_ledger_balance/
get_receivables; reads = `generate_report` so owner/accountant/viewer may ask, staff denied;
connect/bind owner-only; trust contract verified|verified_with_warnings|ambiguous|partial|stale|
unavailable|failed — figures render ONLY from verified±warnings; Postgres job queue + long-poll
connector API `/connector/register|claim|result`, device token SHA-256-at-rest, setup-code
pairing like WhatsApp onboarding), new **`packages/tally-connector`** (customer Windows box,
outbound-only, official Tally XML Envelope/Collection on localhost:9000, deterministic SIMULATOR
whose results production REJECTS). Agent: 6th skill `tally-accounts`, TALLY system-prompt ¶,
optional `TALLY_MCP_URL` (same pattern as payments). GDPR purge covers the 3 tables. Compose
`tally` service + CI/CD matrices + Dockerfile updated. Tests: shared+13, connector 15,
mcp-tally 26 (incl. worst-case probes: lying Tally caught, forged cross-connector result,
double-claim race, revoked/expired/replayed codes, prompt-injection-as-data, prod-rejects-
simulator). **Real-TallyPrime verification pending** (docs/TALLY-INTEGRATION.md §10); Caddy
`/tally/*` route + agent re-publish are deploy-time steps (DEPLOY.md §5a). Tracker: PROGRESS.md.

**✅ PILOT LAUNCH — signup, admin panel, runtime config, live E2E — DONE (2026-10-05; 720 tests):**
PRs #85 #86 #87 (+ follow-up). Meta business verification is DONE (portfolio "Atomberg Technologies
Private" 573614351160243, `verified`); ALL 12 templates APPROVED incl. `pairing_code` (AUTHENTICATION).
- **Self-serve signup:** hisabkitab.pro/pilot form → `POST /signup` (CORS: hisabkitab.pro) → pending
  tenant + 6-digit code BOUND to the claimed number, sent via `pairing_code` → owner sends `START <code>`
  (or pastes the 6 digits) FROM that number → active + 14-day trial (`signup.trial_plan`). Honeypot,
  per-IP (trustProxy), 3 codes/number/24h, daily cap, advisory lock, 5 wrong tries burn the code, code
  expiry on the DB clock. `src/signup/*`, pairing.ts.
- **Admin panel** `https://api.hisabkitab.pro/admin` (orchestrator, encapsulated Fastify plugin): scrypt
  `ADMIN_PASSWORD_HASH` (`pnpm --filter @hisab/orchestrator admin:hash`; unset = 404), failed-login
  lockout, Strict cookie + CSRF + Origin, CSP/noindex, `admin_events` audit. Overview (live Meta number/
  templates/subscription, Khalti mode, counts), Settings, Businesses (setup + code, resend, suspend,
  Khalti payment link), Subscribe webhooks / Submit missing templates. `src/admin/*`.
- **Inbound sender filter:** the HISABKITAB Meta app is ALSO subscribed to the Chatbot-Platform account
  (a different product of the same owner). Messages whose `metadata.phone_number_id` ≠ `wa.phone_number_id`
  are dropped (fail closed). Never remove this.
- **New templates:** `team_invite` (invitee notified), `payment_link` (URL button →
  `/payments/go/<pidx>` redirect, Khalti-host allowlist, works behind Caddy's /payments strip),
  `payment_received` (transactional **outbox** `outbound_notifications`, written in the settlement tx,
  dedupe per pidx, drained every 15s), `admin_account_update` (signup alert; Meta rejected 3 wordings
  that carried owner name/number as INCORRECT_CATEGORY — keep alert templates PII-free).
- **Fixes found live/by review:** GDPR purge skipped subscriptions/billing_payments (any trial tenant was
  undeletable); Audit Gate reset evidence after each hold + never saw the inclusive total → correct drafts
  held 3x (now whole-turn evidence, owner-typed figures are evidence, tools return `total_paisa`,
  `confirm_entry` returns amounts); agent had no clock (recorded 2025) → every turn prefixed with Nepal
  AD+BS date (`todayContext`); admin gate raw-URL bypass (`/%61dmin`) → route-bound plugin; XFF spoofing
  → `trustProxy` private hops; PAYMENTS_LIVE never reached the payments container.
- **Landing:** Kritrim Baudhikata Anusandhan Kendra Nepal Pvt. Ltd. (Reg 354368/81/82, PAN 621236859) as
  the Nepal company + Khalti merchant of record (`NEPAL_COMPANY`, `NepalCompanyCard`) in footer/About/
  Terms/Privacy/Pay; Atomberg stays "Operated by" (Meta). CTAs → `/pilot#signup`.
- **Live verification 2026-10-05 (prod, real Meta + Anthropic, total spend ≈ Rs 5):** real OTP delivered to
  +977 970-5651002, owner replied START from WhatsApp → paired + welcome; draft→confirm sale; gate 0 holds
  after fix; forged signature 401; password-in-chat blocked before the agent; foreign-number message
  ignored; replayed message id deduped. Prod DB browse: read-only role `hisab_readonly` over SSH tunnel
  (`docs/secrets/prod-db-tunnel.sh`). **All creds: `docs/secrets/HISABKITAB-CREDENTIALS.txt` (local only).**
- **Sender number:** temporary live test used +977 981-4344114 (Chatbot-Platform's number, owner-approved,
  then restored). Target pilot sender (the owner's chosen SIM, see the local credentials file) is still registered on the WhatsApp app — free
  it (delete WhatsApp on that SIM), then add+OTP+register via the Meta MCP and switch in the admin panel.
- Khalti merchant email: `docs/KHALTI-MERCHANT-EMAIL.md` (local).

**✅ Signup + admin incident fix — DONE (2026-10-05, PR #89, migration 0020):** undelivered pairing codes
(`send_failed_at`) never count toward the 3/number/24h or daily limits (a #131030 test-number refusal had
locked a real owner out); send failures classified recipient vs service (`WaError.metaCode`), logged to
`admin_events` `signup.send_failed`. Admin POSTs were ALL 403 in real browsers (Referrer-Policy no-referrer ⇒
Chrome sends `Origin: null`): gate is now `isSameOriginPost` (Fetch Metadata) + CSRF; admin sends
`Referrer-Policy: same-origin`, Caddy's is `?`-default. Suspended business ⇒ "account paused" reply (was a
signup loop); own sender number refused at signup/admin create. **Open decision:** billing-suspended
subscriptions still get full agent access (PRD says read-only + renew prompt).

**⬜ PENDING — build in this order:**
- ✅ **Required-for-first-paid-customer subset COMPLETE:** ✅ **P8** identity/RBAC → ✅ **P9** idempotency
  → ✅ **P10** billing → ✅ **P11** cost controls → ✅ **P15** security (minimal) → ✅ **P16** infra/CI-CD.
  **The product can now charge its first paying customer** (after the external pilot prerequisites below).
- ⬜ **Defer until volume** (v2.0, build only as demand requires): ⬜ P12 voice, ✅ P13 accounting
  completeness (CORE + REMAINDER done), ✅ P14 observability (Tier 1 done; Tier 2 breakers/DLQ +
  Tier 3 canary/SLO-paging deferred to deploy), ⬜ P17 growth, ⬜ P18 support/admin,
  ⬜ P19 accountant channel.

**✅ PRODUCTION DEPLOY — LIVE on Tencent Cloud (re-provisioned 2026-10-02):** Lighthouse VM `hisab`
`43.152.239.105` (`lhins-o9qb5zjn`, Bangkok, Ubuntu 26.04, 2 vCPU/3.6 GB, ubuntu, key `hisab.pem` —
VM runs ONLY hisabkitab; kribaat.com is a DIFFERENT server, 43.152.233.234, never touch). The old VM
(43.128.216.245) was deleted with its data; the new one started from an empty DB. **The host is now
infra-as-code: `infra/vm/bootstrap.sh`** (idempotent: swap, Docker, Caddy, ufw 22/80/443, fail2ban,
unattended-upgrades, nightly `pg_dump` backup 14d, 5-min health watchdog, daily disk guard, clone + compose up) +
`infra/vm/Caddyfile` (api.hisabkitab.pro + `<ip>.sslip.io` fallback; /ledger /payments /tally prefix
routes; **/metrics 403 via a `handle` block — a bare `respond` loses to `handle_path` and leaked
metrics**). Rebuild a lost VM = prod `.env` + `bootstrap.sh` (runbook `docs/DEPLOY.md §1`). All 18
migrations applied; 4 services healthy; cold reboot self-heals <90s. CD (`DEPLOY_*` secrets → new VM)
deployed sha-12652a4 green. Agent v11 already targets `https://api.hisabkitab.pro/{ledger,payments}/mcp`.
Meta status (Graph-checked): ALL templates APPROVED, WABA APPROVED; business verification still in
Meta review — NO public API exists to submit/expedite; resubmit only offered after a REJECTION.

**✅ Disk guard + skills sync (2026-10-09):** every deploy left its ~3 GB of images behind (disk hit 66%,
74 images; pruned to 26%). `infra/vm/hisab-prune.sh` keeps the newest 3 deploys (rollback), escalates at
75%/85% (keep 2/1, apt + journal cleanup), never touches volumes/backups/in-use images, steps aside during a
deploy, flock-locked. `infra/vm/install-ops.sh` is the ONE place for backup/watchdog/prune + cron + journald
cap (200M); bootstrap AND every CD deploy run it, then the guard. Admin Overview shows a Server card + red
DISK ALMOST FULL banner at >=85% (`admin/server-health.ts`, same tiers). Live agent v12 = local minus the
TALLYPRIME paragraph and the tally-accounts skill (Tally not attached in prod, by design): push a changed
skill with a single `skills.versions.create`, NEVER `agent:setup --update` (it would add Tally).

**✅ Template billing shield (2026-10-08):** Meta re-categorised 3 dunning templates as MARKETING;
replaced by `plan_renewal_notice`/`plan_ended_notice`/`plan_paused_notice` (plain "Account update" wording).
`whatsapp/category-guard.ts` checks each template's LIVE category before every send (WaClient hook) and
refuses MARKETING; `billing-guard.test.ts` lints wording (no sales nudges, no edge {{vars}}); admin panel
shows a Category column. Never declare a MARKETING template.

**✅ Pilot applications reviewed by hand (2026-10-08, migration 0021):** `signup.require_approval`
(admin Settings, default ON): the pilot form only records an APPLICATION (pending tenant,
`review_status='awaiting'`, `applicant_e164`), sends NOTHING to the number, alerts the admin, and the
landing shows a "you are on the list / in review" popup (`landing/app/pilot/ReviewDialog.tsx`). Admin →
Businesses → **Approve** sends the `account_approved` Utility template (falls back to a `pairing_code`
if Meta refuses it) and the applicant's FIRST message from that number pairs it (Meta-verified sender =
proof); awaiting applicants get "under review", never paired. **Decline** sends nothing; re-applying
re-queues. Approved owner who missed the message: resubmit form → code. OFF = old instant-code flow.

**✅ Onboarding delivery tracking + self-healing retries (2026-10-08, migration 0022):** every approval
notice / verification code goes through `onboarding/delivery.ts` (`deliverCode`/`deliverApproval`) and is
recorded in `onboarding_messages` with Meta's wamid; the status webhook (`server.ts onDeliveryStatus`) folds
reports in as a max-register (accepted<sent<failed<delivered<read: any order/duplicates converge). Failures
are classified by Meta code (`delivery-policy.ts`): account (131042 billing) / transient → exponential
backoff with seeded jitter, max 5 sends; template → immediate fallback to a code; recipient → parked. Account
failures open a circuit breaker: ONE probe at a time until something is delivered. Retrier ticks every 30s,
claims with FOR UPDATE SKIP LOCKED. ONE clock: the DB's (`dbNow`). Admin: per-row delivery pill, Retry now,
"SENDER DEGRADED" banner, undelivered count. Root incident: 2026-10-08 code to +977…1002 accepted then 131042.

**🌐 EXTERNAL (remaining, not code):** ✅ DNS `api` → 43.152.239.105 (Let's Encrypt cert issued) and
✅ webhook registered to `https://api.hisabkitab.pro/webhook` (Meta `active:true`), both 2026-10-02.
Still open: ① Lighthouse console: enable automatic snapshots (off-box backup). ② ✅ Dedicated sender
DONE 2026-10-08: new WABA "HisabKitab" (FINANCE) registered via the WhatsApp Business Tools MCP, app
subscribed, 12 templates submitted, admin Settings switched (IDs + 2-step PIN in the local creds file). ③ Khalti merchant onboarding
(email ready; needs tax clearance cert) → paste live key in admin Settings. ④ Pause the chatbot-platform
app subscription if both products must ever share one number again (no token for it locally).

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
