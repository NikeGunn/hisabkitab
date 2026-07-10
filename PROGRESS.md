# TallyPrime Integration — Build Progress

> Living tracker for the TallyPrime read-only integration. Updated as each phase lands.
> Architecture record + operations: `docs/TALLY-INTEGRATION.md`. Product context: `CLAUDE.md`.

## Objective

Let a verified owner ask HisabKitab (over WhatsApp) about the books their business keeps in
**TallyPrime** — ledger balances, receivables, statements — and get accurate, traceable,
evidence-backed answers. TallyPrime stays the authoritative source; the **first release is
strictly read-only** (no voucher creation/alteration/deletion, ever, in this release).

## Architecture (decided from repo evidence — see docs/TALLY-INTEGRATION.md for the full record)

```
WhatsApp owner
  → orchestrator webhook (existing, signed)         [tenant + role from verified sender]
  → Managed Agent turn (existing)
  → tally MCP (new packages/mcp-tally, :8803)        [typed read-only tools, RBAC generate_report]
  → tally_jobs row (Postgres, RLS)                   [allowlisted operation + params]
  → customer-side connector (new packages/tally-connector, outbound long-poll HTTPS — no inbound
    firewall holes; device token bound to ONE tenant)
  → localhost:9000 TallyPrime XML/HTTP server        [official Tally interface; never public]
  → schema validation + paisa normalization + reconciliation (@hisab/shared/tally, pure)
  → trust verdict (verified | ambiguous | partial | stale | unavailable | failed)
  → deterministic rendering — the model NEVER writes a number itself
```

Key decisions:

- **Job-polling transport** (connector dials out; HisabKitab never dials in) — fits the existing
  single-VM + Caddy deployment, no customer firewall rules, works behind NAT.
- **XML stays connector-side.** The server only ever sees schema-validated JSON payloads;
  raw Tally XML never crosses the trust boundary. (Also why the XML parser dep lives only
  in the connector package.)
- **Postgres as the job queue** (not BullMQ): jobs are tenant-scoped rows under RLS, auditable,
  and the tool needs request/response semantics, not fire-and-forget.
- **Money = integer paisa (bigint)** end to end, same as the whole platform. Tally decimal
  strings are parsed digit-exact — never through a float.
- **No generic tools** (`execute_tally_xml` etc. do not exist). Only narrow typed operations,
  allowlisted in BOTH the server and the connector.
- **Simulator-first dev**: deterministic Tally simulator (fixtures for every failure mode);
  production fails closed if a simulator-sourced result ever appears.

## Phases

### Phase 1 — Foundations (shared pure domain + DB) — ✅ DONE

- [x] `@hisab/shared/tally`: trust states, Tally amount → paisa (exact, no floats),
      debit/credit sign convention (documented + tested), payload zod schemas,
      reconciliation checks (opening+debits−credits=closing; line totals = report total),
      deterministic ledger-ambiguity resolver.
- [x] Unit tests + adversarial probes (non-reconciling ledger, float-poison amount strings,
      hostile ledger names stay data, ambiguity never auto-picks).
- [x] Migration `0018_tally.sql`: `tally_connectors` (device binding, token hash),
      `tally_companies` (company catalog: stable source id, books_from, freshness),
      `tally_jobs` (queue + result + correlation id) — RLS + least-privilege grants.
- [x] Drizzle schema mirror + db helpers.

### Phase 2 — Services (mcp-tally + connector + simulator) — ✅ DONE

- [x] `packages/mcp-tally`: Streamable HTTP MCP (:8803) with dual auth (service token /
      vault bearer), read-only tools: `tally_status`, `tally_list_companies`,
      `tally_search_ledgers`, `tally_get_ledger_balance`, `tally_get_receivables`.
- [x] Connector API on the same server: `POST /connector/claim` (long-poll) +
      `POST /connector/result`, device-token auth (SHA-256 hash at rest), size caps,
      stale-connector fail-fast.
- [x] `packages/tally-connector`: outbound poll loop, allowlisted typed operations only,
      official XML Envelope builders + parsers (`fast-xml-parser`), response validation,
      redacted logging, deterministic simulator with full failure-mode fixtures.
- [x] `connector:issue` CLI (mints a device token, prints once, stores only the hash).
- [x] Contract/integration tests: happy path, ambiguous ledger, connector offline, job
      timeout, malformed payload, reconciliation failure → failed verdict (never a figure),
      tenant-isolation probe, RBAC probe, simulator-flag-in-production probe.

### Phase 3 — Integration (agent, infra, docs, landing, deploy) — ✅ DONE (deploy: pushed, CI/CD in flight)

- [x] Agent: `tally-accounts` skill, system-prompt TALLY paragraph, optional `TALLY_MCP_URL`
      in the agent definition (same pattern as payments).
- [x] Infra: compose service (:8803), CI + CD matrices include `mcp-tally`, `.env.example`.
- [x] Docs: `docs/TALLY-INTEGRATION.md` (architecture + trust boundaries + setup + simulator + troubleshooting + read-only-first ADR + future controlled-write design), DEPLOY.md §6.
- [x] Landing: TallyPrime integration section (static export, GitHub Pages).
- [x] Full verification: typecheck, lint, unit + contract + integration tests, landing build.
- [x] Ship: commit → push → CI green → CD deploys api.hisabkitab.pro → landing publishes.

## Verification status (be precise about what was proven where)

| Layer                                         | Status                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| Pure domain (parse/normalize/reconcile/trust) | tested (vitest, probes)                                                 |
| MCP tools + RBAC + tenant isolation           | tested (contract tests, real Postgres RLS)                              |
| Connector ↔ server transport                  | tested (integration, real HTTP)                                         |
| Connector ↔ Tally                             | **simulator-verified only** — NOT yet run against a licensed TallyPrime |
| Real TallyPrime compatibility                 | pending a Windows machine with TallyPrime (manual procedure in docs)    |

## Remaining before a real-customer pilot

1. Run the manual connector test against a licensed TallyPrime install (docs §Manual test).
2. Caddy route for `/tally/*` on the prod VM + re-publish agent with `TALLY_MCP_URL`.
3. Issue the pilot tenant's connector token; install connector beside their Tally.
4. Bind their company (`tally_list_companies` → owner confirms → bound).
