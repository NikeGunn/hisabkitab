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

## Status — Phase 0 complete
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
Phase 1: PostgreSQL 16 + drizzle + RLS schema; Ledger MCP (record / validate / draft→confirm).
