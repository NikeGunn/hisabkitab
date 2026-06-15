# Contributing to HisabKitab

Thanks for your interest. This is a finance product, so correctness and safety beat speed.

## Ground rules (non-negotiable)

These come from `CLAUDE.md` and the PRDs and are enforced in code and review:

- **Never fabricate data.** Low-confidence or missing input → ask, don't guess.
- **Confirm before save.** Every entry is a draft until the owner confirms it.
- **Money is integer paisa (`bigint`), never floats.** 1 NPR = 100 paisa.
- **No financial figure** leaves a tool/report without passing the Audit Gate.
- **Server-side authorization** — role/permission checks live in the MCP tools + RLS, not the prompt.
- **No secrets in the repo** — `.env.example` only.

## Local setup

```bash
pnpm install
# bring up Postgres + Redis + migrations + all services:
pnpm up            # docker compose dev
```

Tests need Postgres + Redis. CI provisions them; locally `pnpm up` does too.

## Before you open a PR

```bash
pnpm typecheck     # tsc --strict, must be clean
pnpm lint          # eslint, must be clean
pnpm test          # full vitest suite, must be green
```

- Write **tests first** for any money/VAT/TDS/aging/allocation/auth logic, and include at
  least one **adversarial probe** — a fixture designed to be wrong that the code must catch
  (a non-reconciling total, a duplicate invoice, an under-privileged caller). Happy-path-only
  changes to high-risk code will be asked to add a probe.
- Keep PRs small and focused. Conventional commit prefixes: `feat`, `fix`, `docs`, `refactor`,
  `test`, `chore`, `ci`.

## Merging

`main` is protected: PRs require the CI checks (`test` + the three `docker-build` jobs) to pass,
and merge is **squash-only** with the branch auto-deleted. You can enable auto-merge on a green PR.

## Branch naming

`feat/…`, `fix/…`, `chore/…`, `docs/…` — short and descriptive.
