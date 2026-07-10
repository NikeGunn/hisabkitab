# HisabKitab (हिसाबकिताब) — your pocket accountant on WhatsApp

> **Log a bill by photo or voice. Get VAT-ready in seconds. You approve every entry — it never guesses.**

WhatsApp-first bookkeeping & tax assistant for small VAT-registered businesses in Nepal, built on
Claude Managed Agents. *Hisab-kitab* is the everyday Nepali phrase for "keeping the books" — that is
exactly, and only, what this product does.

**The promise (process guarantee, not "zero mistakes"):** nothing is ever saved or filed without the
owner's confirmation. The agent shows its work, flags anything it's unsure about, and never guesses.

## Docs
- `CLAUDE.md` — build rules and process (authoritative).
- `docs/PRODUCT.md` — product one-pager + spec map.
- `docs/nepali-smb-finance-agent-PRD*.md` — v1.0 base, v1.1 (safety + verified tax, authoritative),
  v1.2 (reports module), v2.0 (commercialization — build after the pilot).

## TallyPrime integration (read-only) — NEW

Businesses that keep their books in **TallyPrime** can connect them to HisabKitab and simply ask
on WhatsApp: *"What's Sharma Traders' balance?"*, *"Who owes me?"*, *"Show outstanding bills."*

- **Pull, never push.** The integration is read-only **by construction** — there is no code path
  (tool, DB constraint, or connector operation) that can create, alter, or delete anything in Tally.
- **Setup is one code.** The owner texts "connect my Tally", gets an 8-character setup code, and
  types it into a small connector app on the computer that runs Tally. The connector only dials
  OUT (long-polling) — no port forwarding, no firewall changes, Tally's port 9000 stays local.
- **Every figure is verified.** Results are schema-validated and independently reconciled
  (opening + credits − debits must equal closing; bill lines must sum to the report total) with
  exact integer-paisa arithmetic. If the numbers don't tie, the owner is told the figure could
  not be verified — a wrong number is never shown. Trust states:
  `verified · verified_with_warnings · ambiguous · partial · stale · unavailable · failed`.
- **Ambiguity is never guessed.** "Sharma" matching three ledgers returns the candidates; the
  owner picks. Who may ask: owner, accountant, viewer (server-side RBAC); setup and company
  binding are owner-only.
- **Deterministic simulator** (`packages/tally-connector`) covers every failure mode for local
  dev/CI — and production **rejects** simulator-sourced results, fail-closed.

Packages: `packages/mcp-tally` (typed MCP tools + connector API) ·
`packages/tally-connector` (customer-side connector + simulator) ·
`packages/shared/src/tally` (pure money/reconciliation/trust core). Tracker: `PROGRESS.md`.

## Status — Phases 0–6 complete

**Phase 6** ships the monthly VAT-return reminder scheduler in
`packages/orchestrator/src/scheduler/` (PRD v1.1 Phase 6 / §11). A **BullMQ +
Redis** repeatable job runs daily and, for the BS month that just ended, for each
active VAT-registered tenant: runs the deterministic `generate_return_summary`
(no agent, no API spend), then **independently self-verifies** the figures
(`self-verify.ts` re-derives `net_payable == max(Σ confirmed sales.vat − Σ
eligible input_vat, 0)`, `is_nil`, and that no entry has an unresolved `fail`) —
PASS → send the `return_prepared` Utility template with the net payable; not-PASS
→ **HOLD the numbers** and send the figure-free `vat_due_soon` deadline nudge,
flagged for review (never state an unverified figure). Exactly-once is owned by
the DB (`reminder_log` unique `(tenant, bs_year, bs_month, kind)`, migration
0004), NOT the queue — so the daily tick is idempotent, a down day recovers the
next, and retries/replicas never double-send. Migration 0005 grants `hisab_orch`
read access to `expenses`/`validation_events` for the cross-tenant self-verify.
Consent is untouched: a reminder only prepares + nudges; the owner still gives an
explicit "✅" before `mark_return_filed_by_user`. **7 contract tests** (real
Postgres, the real ledger summary + self-verify, captured sends) + a runtime
harness (`verify:scheduler`, **4/4 PASS** against live Redis incl. the BullMQ
round-trip and a self-verify-holds-a-lie probe) — all local, no API spend. The
agent **model is now config** (`HISAB_MODEL`): cheap Sonnet for dev, Opus for the
pilot. Verified once against the **real Managed Agents API** on Sonnet
(`verify:live --session`, 4/4): the live agent declined an off-topic question and
**refused to state an unverified VAT figure with the ledger unreachable** (the
Audit Gate held end-to-end).

## Status — Phases 0–5 complete

**Phase 5** ships `packages/mcp-payments`: a tenant-bound Payments MCP over Streamable HTTP
(`initiate_payment` / `verify_payment` / `refund_payment` / `list_collected_payments` + eSewa &
Fonepay "coming soon" stubs), plus the public unauthenticated `GET /payments/khalti/return`
callback. **Khalti (KPG-2) is live** via a real `KhaltiClient` whose code path is identical whether
it talks to a local byte-faithful stub, `dev.khalti.com` sandbox, or production. Non-negotiables are
enforced in the tools, not the prompt: the consent gate is a zod `literal(true)` (`owner_approved` —
unparseable without the owner's explicit ✅), the server-side **lookup is the only source of truth**
(callback params and model claims are never trusted), amounts are reconciled (`lookup.total_amount`
must equal the initiated amount or the payment is flagged `amount_mismatch` and never completed), and
recording is **exactly-once** (`pidx` unique + `sale_id` latch in one tenant transaction → one
CONFIRMED gateway sale with the exact VAT-inclusive split). The agent is wired to it: `definition.ts`
mounts the payments MCP + `always_allow` toolset, a new **nepal-payments skill** teaches the
consent→initiate→verify flow, and the system prompt gained a PAYMENTS paragraph. Migration `0003`
adds the `payments` table (RLS) and `sales.source='gateway'`. **19 contract tests** (real Postgres
as the RLS role, real MCP client, real KhaltiClient over the stub) + a runtime harness
(`pnpm --filter @hisab/mcp-payments verify`, **8/8 PASS**) drive the real HTTP server and callback
through every probe: refused unconsented initiate, forged "Completed" callback, tampered amount,
replayed callback, cross-tenant settle. All verified locally — **no Anthropic API spend**. The same
suite runs unchanged against the real Khalti sandbox once the merchant key is issued.

## Status — Phases 0–4 complete

**Phase 4** ships the bill-extraction confirmation loop, proven end-to-end with messy bills
(`packages/orchestrator/src/bills/`): a fixture manifest of 8 adversarial dummy bills — clean
Rule 17, lying grand total, 17Ka abbreviated, smudged invoice number, unreadably blurred photo,
duplicate resend, >1-year-old PDF, and a **real photographed bill** (`fixtures/wild/`) whose
printed VAT is Rs 3 off the true 13% — rendered deterministically (SVG→PNG via sharp + a
hand-rolled PDF). `verify:bills` drives them through the REAL ledger MCP over HTTP
(validate → record draft → owner confirm; 10 checks). `verify:bills -- --live` runs the real
agent over each image through a cloudflared quick tunnel: **6/8 live PASS** including the full
loop — photo → vision extraction → `validate_entry` → echo → owner "yes" → a `confirmed` row
with exact paisa in Postgres — plus held mismatches, denied 17Ka credit, a duplicate warning,
and no invented figures from the blurred bill. Hardening that fell out: `validate_entry` echoes
`validated_figures` (Audit Gate evidence for pre-save echoes), the MCP toolset is pinned
`always_allow` (the `always_ask` default stalled sessions), and `runTurn` enforces its deadline
against silent streams + interrupts stuck turns.

**Phase 3** ships the WhatsApp layer in `packages/orchestrator`: a Fastify webhook server
(Meta handshake + `X-Hub-Signature-256` verified over the raw bytes), zod-parsed inbound
envelopes, **exactly-once** processing (Meta retries dedupe on the `wa_events` PK), per-tenant
message serialization, onboarding/pairing ("START 4821" binds the number, activates the tenant,
consumes the code, audit-logs), a persistent per-tenant session registry (`tenant_sessions`),
media→Files (Graph download → Files API → container mount at `/workspace/inbox/...`), outbound
replies through the Audit Gate, and the three Utility templates ready to submit
(`templates:submit`). Migration `0002` adds the `hisab_orch` webhook role (cross-tenant by
design — the orchestrator mints the tenant tokens) while `hisab_app` stays RLS-scoped.
Verified live (`verify:wa -- --live`, 9/9): signed webhook → pairing → real agent session →
a blank "bill" image was mounted into the container and the agent **asked for a clearer photo
instead of inventing data**.

**Phase 2** ships `packages/orchestrator`: the Managed Agents agent definition (frozen system
prompt, ledger MCP wiring, the three skills synced via the Skills API), idempotent one-time
`agent:setup` (skills → environment → agent), per-tenant **vaults** holding the HMAC-signed
ledger bearer, the session client (stream-first event loop, one session = one tenant), and the
**Pre-delivery Audit Gate** in the relay path — every outbound money figure must be traceable to
a same-turn ledger tool result or the message is held, the agent is told to re-verify or ask the
owner, and the decision is logged to `audit_log`. Verified live against the real API
(`pnpm --filter @hisab/orchestrator verify:live -- --session`): the scope guardrail declined an
off-topic question, and the gate held an unverified VAT figure end-to-end.

**Phase 1** ships `packages/db` (Postgres 16+ schema via drizzle, **Row-Level Security** on every
tenant table — fails closed, app role cannot bypass) and `packages/mcp-ledger` (a tenant-bound MCP
server over Streamable HTTP: record/validate/draft→confirm tools, tenant derived only from
HMAC-signed session metadata, every write audited). 24 contract tests run a real MCP client against
real Postgres as the RLS-constrained role; `pnpm --filter @hisab/mcp-ledger verify` drives the live
HTTP server. See `packages/db/migrations/0001_init.sql` for the schema.

### Phase 0
`packages/shared` ships the foundations, each with happy fixtures **and adversarial probes**:

| Unit | What it does |
|---|---|
| `money` | Integer-paisa (`bigint`) arithmetic, exact half-up rounding, NPR lakh formatting, strict parsing |
| `config/tax` | FY 2082/83 rates as config (env-overridable, zod-validated) — never scattered literals |
| `vat` | Inclusive/exclusive 13% math (`excl+vat===total` invariant), carry-forward, Sec 18 input-credit eligibility (Rule 17 vs 17Ka, 1-year window) |
| `tds` | All v1.1 §5.2 categories on the VAT-exclusive base; ambiguous cases return `ask_accountant`, never an estimate |
| `bsdate` | BS↔AD via pinned `nepali-date-converter`, month ranges, 25th-of-next-month VAT deadline |
| `aging` | AR/AP aging buckets (current/1–30/31–60/61–90/90+), independent report re-verification |
| `validation` | Layer-2 Validation Engine: `pass`/`warn`/`fail` checks (VAT math, totals, credit, duplicates, TDS base, sanity) |
| `verification` | `PASS\|FAIL\|BLOCKED\|SKIP` verdicts shared by human + agent + CI |

```sh
pnpm install
pnpm test        # vitest: 84 tests
pnpm verify      # runtime verification: 16 checks incl. 10 adversarial probes
pnpm typecheck   # tsc --strict
```

## Next
Phase 7 (v1.1) — hardening & pilot: credential-scrubbing guard, tenant data-deletion path,
rate-limit/retry handling; then pilot 5–10 cafés, VAT-only, one city. Still external (not code):
Meta business verification + number (webhook is ready), Khalti **merchant onboarding** (sandbox at
`test-admin.khalti.com`; production needs the MOU docs — see `manual.txt`), a Redis instance for the
scheduler, and a public https deployment of the Ledger + Payments MCP servers. The gitignored
`manual.txt` holds the setup manual and the Khalti sandbox/production details.
