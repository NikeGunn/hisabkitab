# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# HisabKitab backend services — one parameterized multi-stage build for all three
# (orchestrator / mcp-ledger / mcp-payments). Pick the service at build time:
#   docker build --build-arg SERVICE=mcp-ledger -t ghcr.io/<owner>/hisab-mcp-ledger .
#
# Design (FAANG-grade, justified):
#  • Multi-stage: a fat `deps` layer (cached on lockfile), a `build` layer that
#    typechecks, and a slim runtime that carries only what's needed.
#  • Non-root user, tini as PID 1 (reaps zombies, forwards SIGTERM for graceful
#    shutdown — the services already handle SIGTERM).
#  • Runtime is node:20-slim (NOT distroless) on purpose: the workspace runs TS
#    via `tsx` and imports sibling packages by `workspace:*` source, so a Node
#    loader must be present. Precompiling to JS + distroless is a documented
#    future optimization (see docs/DEPLOY.md), not a correctness requirement.
#  • Pinned base by digest-friendly tag; reproducible pnpm via corepack.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20.19.0

# ── deps: install the FULL workspace once, cached on the lockfiles ────────────
FROM node:${NODE_VERSION}-slim AS deps
ENV PNPM_HOME=/pnpm CI=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
# Copy only manifests first so the install layer is cached unless deps change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/db/package.json            packages/db/package.json
COPY packages/mcp-ledger/package.json    packages/mcp-ledger/package.json
COPY packages/mcp-payments/package.json  packages/mcp-payments/package.json
COPY packages/orchestrator/package.json  packages/orchestrator/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── build: bring in sources and typecheck (fail the image on a type error) ───
FROM deps AS build
COPY . .
RUN pnpm -r typecheck

# ── runtime: slim, non-root, tini, only the selected service is the entrypoint ─
FROM node:${NODE_VERSION}-slim AS runtime
ARG SERVICE
RUN test -n "$SERVICE" || (echo "ERROR: --build-arg SERVICE=<orchestrator|mcp-ledger|mcp-payments> is required" && false)
# Writable HOME + corepack cache for the non-root user (corepack writes a cache
# on first pnpm invocation; without a writable HOME it crashes at runtime).
ENV NODE_ENV=production CI=1 PNPM_HOME=/pnpm HOME=/home/hisab COREPACK_HOME=/home/hisab/.corepack
ENV PATH=$PNPM_HOME:$PATH SERVICE=${SERVICE}
RUN apt-get update && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 hisab \
 && useradd  --system --uid 1001 --gid hisab --home-dir /home/hisab --create-home hisab \
 && corepack enable \
 && mkdir -p "$COREPACK_HOME" && chown -R hisab:hisab /home/hisab
WORKDIR /app
# Whole built workspace (node_modules incl. tsx + the source the loader runs).
COPY --from=build --chown=hisab:hisab /app /app
USER hisab
# Pre-warm corepack's pnpm shim as the runtime user so the first request doesn't
# pay a cache-write (and proves pnpm is runnable non-root).
RUN corepack prepare pnpm@10.14.0 --activate
# Each service reads PORT; defaults documented in compose/k8s. 8080 is the convention.
ENV PORT=8080
EXPOSE 8080
# tini → pnpm start for the chosen package, so SIGTERM reaches Node for graceful close.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "pnpm --filter @hisab/${SERVICE} start"]
