# Implementation status — Rehearsal Lab (2026-10-10)

## Done (with evidence)

| Area                                                                             | Evidence                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Seeded env, 12 families × 10 scenarios, hidden oracle, train/dev/test            | `test/rehearsal.test.ts` (catalog, oracle-never-leaks, replay digest, snapshot tamper) |
| Deterministic judge (hard → outcome → trajectory)                                | probes: eager → UNAPPROVED_SAVE, injection, duplicate, cross-tenant, gate HOLD         |
| Real agent rehearsal (prod prompt, skills, tool schemas, Audit Gate)             | live runs saved in lab DB + LangSmith                                                  |
| Durable worker (lease, fencing token, atomic commit, write-ahead decision)       | kill -9 drill + `test/durable.db.test.ts` (7)                                          |
| Isolation (`hisab_lab` → `rehearsal` only; append-only events)                   | DB probes: permission denied on customer tables / event UPDATE                         |
| Release gate (shared) + human approval in admin panel                            | `release-gate.test.ts` (9), `admin-lab.test.ts` (7)                                    |
| LangSmith traces + scored experiments (test split never exported)                | experiments careful/eager/policy:rules on dev                                          |
| GRPO policy learning + reward-hacking ablation, SFT export                       | `research/` pytest (12), `research/results/*`                                          |
| CI: lab tests, regression gate, Python job, image build                          | `.github/workflows/ci.yml`                                                             |
| Spend lock (`--allow-spend`) + `pnpm lab weekly`                                 | CLI                                                                                    |
| Production lab enabled (2026-10-09), free synthetic evaluations visible in admin | SSH: overview/run/episode HTTP 200; event-chain audits; zero tokens/cost               |
| gVisor installed; Docker DNS compatible worker runtime                           | `runsc-docker` (gVisor with host network stack inside Docker's bridge namespace)       |

| env-4 production parity (2026-10-10): server-side confirm guard, owner figures for the conversation, supersede, validate echo | `rehearsal.test.ts` env-4 block; eager = 0 hard with guards ON, still caught with guards OFF |
| Owner simulator v2 (re-affirms once when asked to re-confirm; answers clarifications from a scenario fact) | correction + multi_turn families |
| Human ruling correction/006 encoded (ask before re-drafting a contradicting figure), dataset `rehearsal-v1.1`, `judge-2` | `clarified_after_correction` required check + probe |
| GRPO results visible in the admin panel | `pnpm lab import-training` (idempotent, + held-out test score); prod imported 2026-10-10 |

Tests run locally 2026-10-10: whole monorepo green (shared 418, ledger 140, orchestrator 353, lab 151+); Python 12 green.
Earlier (2026-10-09): 1,057 TS tests green.

## Not done

- Live A/B on env-3: candidate arm stopped after 3 episodes (budget); live runs are n=1.
- F1 / precision-recall reward + accuracy analytics: planned (local `docs/next-plan.md` §F), not built.
- PPO comparison, open-model (Qwen + TRL) track, image bills, 500-scenario generator: planned.
- Production trace sampling adapter: not built.

## Risks

Synthetic owners can hide or create effects (two simulator gaps already found); small n.
The worker now uses only `LAB_ANTHROPIC_API_KEY` (unset in production), never the production
Anthropic key. `runsc-docker` uses the host network stack for Compose DNS, which provides
less network isolation than gVisor netstack; the Docker bridge and DB permissions remain.

Production commands and rollback: `agents-learning/docs/08-production-vm.md (local)`. On the VM use
`bash agents-learning/scripts/vm-lab.sh ...`, since Node/pnpm are installed inside the image only.

Next: local `docs/next-plan.md`.
