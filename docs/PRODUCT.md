# Nepali SMB Finance Agent — your pocket accountant on WhatsApp

> **Log a bill by photo or voice. Get VAT-ready in seconds. You approve every entry — it never guesses.**

A WhatsApp-first bookkeeping & tax assistant for small VAT-registered businesses in Nepal, built on
**Claude Managed Agents**. A shop owner snaps a photo of a bill (or sends a voice note in Nepali), and the
agent reads it, applies Nepal's VAT/TDS rules, keeps the books, reminds them before the 25th IRD deadline,
and prepares professional debtor/creditor statements and the monthly VAT return — **always showing its work
and asking before it saves anything.**

## Why people use it
- **Replaces the monthly panic** before the VAT deadline with a calm WhatsApp nudge.
- **Cheaper and faster than a part-time accountant**, available 24/7, never forgets a filing.
- **Photo or voice in** → clean books out. No app, no spreadsheets, no forms.
- **Cross-check your accountant:** pull a verified statement any time.

## The promise we actually keep (read before marketing)
**Not** "zero mistakes." The honest, defensible promise is a *process* guarantee:
> *Nothing is ever saved or filed without your confirmation. It shows its work, flags anything it's unsure
> about, and never guesses.*
Every system in these specs exists to make that literally true. (See v1.1 §1A.)

## Plans (hypothesis to test, not final)
Free trial → **Starter ~Rs 999** (logging + reminders) → **Pro ~Rs 1,999** (+ AR/AP + statements) →
**Business ~Rs 2,999** (+ all reports + analytics + accountant seat) → **Accountant** (manage many clients).

---

## Repository / spec map (read in this order)

| File | What it is | Build when |
|---|---|---|
| **`CLAUDE.md`** | Master instructions for Claude Code: rules, process, build order. **Auto-loaded.** | — |
| `nepali-smb-finance-agent-PRD.md` (**v1.0**) | Base architecture, schema, WhatsApp, onboarding, agent + tax skill. | MVP |
| `nepali-smb-finance-agent-PRD-v1.1.md` (**v1.1**) | Anti-mistake safety architecture + verified VAT/TDS. **Authoritative on safety & tax.** | MVP |
| `nepali-smb-finance-agent-PRD-v1.2-reports-module.md` (**Module C**) | AR/AP, professional PDF reports, flexible analytics, scope guardrail. | MVP+ |
| `nepali-smb-finance-agent-PRD-v2.0-production-growth.md` (**v2.0**) | Billing, multi-user/roles, voice, idempotency, cost, observability, security, CI/CD, growth, accounting completeness. | **After pilot** |

Precedence: later versions override earlier ones on conflict. When unsure, **stop and ask** — never guess.

## Build philosophy (from Anthropic's "How We Claude Code")
**Explore → Plan → Verify.** Every unit is runtime-verifiable: it ships fixtures + invariants + at least
one adversarial *probe* designed to fail that the code must catch. Verdicts are `PASS|FAIL|BLOCKED|SKIP`;
**when in doubt, don't pass — hold and ask** (the Audit Gate). A false PASS ships a wrong number to a
business; a false FAIL just costs one more look. (See CLAUDE.md §7–8.)

## What you build vs. what Anthropic hosts
You build three TypeScript services — **Orchestrator** (WhatsApp webhook, sessions, scheduler), **Ledger MCP**
(Postgres, tax/validation/reports), **Payments MCP** (Khalti; eSewa/Fonepay "coming soon"). **Claude Managed
Agents** hosts the agent loop, sandbox, and tracing.

## How to start
```sh
# put all files in one folder, then:
git init
claude
# then: "Read CLAUDE.md and the PRDs, then start Phase 0 — propose the package
#        structure and test/probe list first and wait for my OK."
```

## Honest sequencing
Ship **v1** to 5–10 cafés you know → prove they keep using it → build the v2.0
*required-for-first-paid-customer* subset (identity, idempotency, billing, cost controls) → start charging →
scale the rest with demand. **Sequence beats completeness.** Keep a Nepali lawyer's eyes on ToS/Privacy and
the "assistance, not statutory audit sign-off" disclaimer before taking money.
