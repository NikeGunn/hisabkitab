<!-- Keep PRs small and focused. The CI gate (typecheck + lint + full vitest +
     docker build) must be green before merge — main is protected. -->

## What & why

<!-- One or two sentences. Link the phase / PRD section if relevant. -->

## Changes

-

## Verification (this repo's discipline — runtime-observable, per CLAUDE.md §8)

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` green (note the count)
- [ ] New money/VAT/TDS/auth logic ships an **adversarial probe** that must catch a wrong input
- [ ] No secrets committed; `.env.example` only

## Safety checklist (the product promise)

- [ ] Nothing is saved/filed without owner confirmation
- [ ] No financial figure leaves a tool/report without passing the Audit Gate
- [ ] Money is integer paisa; no floats
- [ ] Role/permission checks are server-side, not just the prompt
