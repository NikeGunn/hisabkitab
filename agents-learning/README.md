# Rehearsal Lab — `agents-learning/`

Where the HisabKitab agent **rehearses real bookkeeping conversations on synthetic data**, gets
**judged by code against a hidden answer key**, and where every candidate change must beat the
current production behaviour **before a human approves it**. Nothing here can touch a customer
ledger: the lab's database role can only see the `rehearsal` schema.

```
 scenario (seeded, synthetic)          agent                         judge (deterministic)
 ─────────────────────────────   ─────────────────────────   ─────────────────────────────────────
 owner messages + OCR'd bills  →  careful | eager | claude  →  1. hard gates  (unapproved save,
 + faults + HIDDEN oracle         | policy:<weights>             cross-tenant, duplicate save) → −1
                                     │                         2. outcome     (exact paisa match)
          RehearsalEnv  ◀────────────┘ tool calls / messages   3. trajectory  (asked when unsure,
   sandbox ledger (prod schemas + VAT + Validation Engine)        declined when it had to, no holds)
   every message → the REAL Audit Gate (held if unverified)
```

## What is reused from production (not re-implemented)

| Production piece                                                                                        | Used here as                                                 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `SYSTEM_PROMPT`, `skills/*/SKILL.md`, `todayContext`                                                    | the real agent's brain in `ClaudeAgent`                      |
| ledger tool zod schemas (`@hisab/mcp-ledger` `inputSchemas`)                                            | the sandbox tools' contract + the JSON schema the model sees |
| `resolveInvoiceVat`, `validateExpense/Sale`, `splitVatInclusive`                                        | sandbox ledger behaviour **and** oracle figures              |
| Audit Gate (`auditOutbound`, `addToolResultEvidence`, `correctiveInstruction`, `HELD_FALLBACK_MESSAGE`) | every agent message in every episode                         |
| `estimateCostPaisa` price table                                                                         | episode cost (with prompt-cache discounts)                   |

## Quick start

```bash
pnpm install
pnpm --filter @hisab/rehearsal test                       # env, judge, solvability, probes
pnpm --filter @hisab/rehearsal lab catalog --split dev     # the scenarios
pnpm --filter @hisab/rehearsal lab run --agent careful --scenario correction/000
pnpm --filter @hisab/rehearsal lab eval --agent eager --split dev      # watch the judge catch it
```

Real model (budget-capped, uses `ANTHROPIC_API_KEY`, `HISAB_MODEL`, `HISAB_EFFORT` from `.env`):

```bash
pnpm --filter @hisab/rehearsal lab eval --agent claude --split golden --budget-rs 150
pnpm --filter @hisab/rehearsal lab compare --baseline reports/claude-dev.json --candidate reports/claude_confirm-protocol-v1-dev.json
```

Durable runs (Postgres, crash-safe; `LAB_DATABASE_URL` = the `hisab_lab` role):

```bash
pnpm lab enqueue --agent careful --split dev
pnpm lab worker            # kill -9 it at any moment; start another; it resumes the same step
pnpm lab audit --run <run-id>   # hash chain intact, events contiguous, exactly-once saves
```

Policy learning (Python ≥3.11 + numpy):

```bash
pnpm --filter @hisab/rehearsal start                  # RL API on 127.0.0.1:8820 (test split refused)
cd agents-learning/research && python -m pytest -q
python -m rehearsal_research.train --reward v1_judge --seed 0
pnpm lab eval --agent policy:research/weights/grpo-v1_judge-seed0.json --split test   # held-out
```

LangSmith (`LANGSMITH_API_KEY`, `LANGSMITH_TRACING=true`): every episode is a trace with the judge's
scores attached as feedback; `pnpm lab ls-experiment --agent careful --split dev` creates a scored
Experiment. The test split is never uploaded.

Admin panel: **`/admin/lab`** — runs, step-by-step trajectories with the hash-chain check, training
curves, and the release review where a person approves or rejects a candidate.

For future production evaluations, log in to the VM over SSH and run:

```bash
cd /opt/hisabkitab
bash agents-learning/scripts/vm-lab.sh enqueue --agent careful --split golden --budget-rs 0
```

The existing worker processes the run automatically. Refresh `/admin/lab` to see
results; the panel currently has no button to start runs. Each enqueue command
creates another evaluation. Viewing existing results needs no SSH command.
pnpm lives inside Docker, so you do not need to install it on the VM.

See the [step-by-step guide](docs/08-production-vm.md#starting-a-new-free-evaluation-in-the-future)
for SSH login, run IDs, expected terminal notices, audits, and troubleshooting.

The worker does not inherit the production Anthropic key. A separate
`LAB_ANTHROPIC_API_KEY` is only needed for explicitly authorized paid rehearsals;
leave it unset for free runs. Deployment steps: `agents-learning/docs/08-production-vm.md (local)`.

## Layout

```
src/contracts.ts        Action / Observation / Event types (the env boundary)
src/scenarios/          12 families × 10 seeded instances, stratified train/dev/test, hidden oracle
src/env/                RehearsalEnv (reset/step/snapshot/restore) + sandbox tools
src/judge/judge.ts      hard gates → outcome → trajectory → reward
src/agents/             careful, eager, claude (real prompt), skill harness + learned policy
src/runner/             in-memory episode loop + durable worker (lease, fencing token, checkpoints)
src/experiment/         evaluate a policy, compare two (release gate lives in @hisab/shared)
src/telemetry/          LangSmith tracing + datasets/experiments
src/store/              Postgres access for the lab role
research/               Python: GRPO trainer, policy, rewards, bootstrap stats, tests
```

## Reproducibility

Every run records `dataset_version` + content hash, `env_version`, `judge_version`, agent version
(model@effort/prompt-variant) and the full event log. **Environment replay** is exact
(`pnpm lab replay` re-executes recorded actions and checks the state digest); **model reruns** are
not bit-identical — compare models over several runs, never one.
