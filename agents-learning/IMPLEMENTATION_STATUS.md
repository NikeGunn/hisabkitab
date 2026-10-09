# Implementation status — Rehearsal Lab (2026-10-09)

## Done (with evidence)
| Area | Evidence |
|---|---|
| Seeded env, 12 families × 10 scenarios, hidden oracle, train/dev/test | `test/rehearsal.test.ts` (catalog, oracle-never-leaks, replay digest, snapshot tamper) |
| Deterministic judge (hard → outcome → trajectory) | probes: eager → UNAPPROVED_SAVE, injection, duplicate, cross-tenant, gate HOLD |
| Real agent rehearsal (prod prompt, skills, tool schemas, Audit Gate) | live runs saved in lab DB + LangSmith |
| Durable worker (lease, fencing token, atomic commit, write-ahead decision) | kill -9 drill + `test/durable.db.test.ts` (7) |
| Isolation (`hisab_lab` → `rehearsal` only; append-only events) | DB probes: permission denied on customer tables / event UPDATE |
| Release gate (shared) + human approval in admin panel | `release-gate.test.ts` (9), `admin-lab.test.ts` (7) |
| LangSmith traces + scored experiments (test split never exported) | experiments careful/eager/policy:rules on dev |
| GRPO policy learning + reward-hacking ablation, SFT export | `research/` pytest (12), `research/results/*` |
| CI: lab tests, regression gate, Python job, image build | `.github/workflows/ci.yml` |
| Spend lock (`--allow-spend`) + `pnpm lab weekly` | CLI |

Tests run locally 2026-10-09: whole monorepo 1,057 TS tests green; Python 12 green.

## Not done
- **Production deploy: NOT performed** (paused by owner). Steps: local `docs/07-deployment-runbook.md`.
- gVisor installed on the VM: no (script ready: `infra/vm/install-gvisor.sh`).
- Live A/B on env-3: candidate arm stopped after 3 episodes (budget); live runs are n=1.
- Production trace sampling adapter: not built.

## Risks
Synthetic owners can hide or create effects (two simulator gaps already found); small n; the lab
worker would share the production Anthropic key unless a separate key is issued.

Next: local `docs/next-plan.md`.
