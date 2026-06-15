# HisabKitab Deploy Runbook

Two independent deploy targets, by design:

| Piece | Hosting | Domain | Pipeline |
| --- | --- | --- | --- |
| **Landing page** (`landing/`) | GitHub Pages (static) | `hisabkitab.pro` | `.github/workflows/landing-pages.yml` |
| **Backend** (3 services) | Single VM, Docker Compose | `api.hisabkitab.pro` (later) | `.github/workflows/ci.yml` + `cd.yml` |

The landing is static, so GitHub Pages is perfect and free. The three backend services are
long running Node servers, so they need a real host (a Tencent Cloud VM running Docker).

---

## 1. Landing page (live today)

DNS is already set on Namecheap to GitHub Pages:

```
A     @     185.199.108.153
A     @     185.199.109.153
A     @     185.199.110.153
A     @     185.199.111.153
CNAME www   nikegunn.github.io.
```

To go live:

1. Push the repo to GitHub (owner `nikegunn`).
2. In the repo: **Settings -> Pages -> Source = GitHub Actions**.
3. Any push that touches `landing/**` runs the Pages workflow, which builds the Next.js
   static export and publishes `landing/out` (it contains `CNAME = hisabkitab.pro`).
4. GitHub provisions the TLS certificate for the custom domain automatically (a few minutes).

Result: `https://hisabkitab.pro` serves the landing, `https://hisabkitab.pro/pay/` serves the
Khalti development preview (a disabled, no-charge preview).

---

## 2. Backend (coming soon, zero-friction switch-on)

Today the **deploy job is dormant**: every push to `main` builds and pushes images to GHCR, but
the SSH deploy is skipped until the server secrets exist. So nothing breaks while there is no server.

### When you buy the Tencent Cloud VM

1. Create an Ubuntu 22.04+ VM, install Docker + the compose plugin.
2. On the VM:
   ```bash
   sudo mkdir -p /opt/hisabkitab && cd /opt/hisabkitab
   git clone https://github.com/nikegunn/hisabkitab.git .   # or your repo URL
   cp .env.example .env        # then fill REAL secrets (never commit this file)
   ```
3. Add these **repo secrets** on GitHub (`Settings -> Secrets and variables -> Actions`):
   | Secret | What |
   | --- | --- |
   | `DEPLOY_HOST` | VM public IP |
   | `DEPLOY_USER` | SSH user (e.g. `ubuntu`) |
   | `DEPLOY_SSH_KEY` | the **private** key (the `.pem` contents) whose public key is on the VM |
   | `GHCR_PULL_TOKEN` | *(optional, private repo only)* a PAT with `read:packages` so the VM can pull images |

   > The day these exist, the **next push to `main` deploys automatically** with zero further changes.
   > The pipeline also sets the secrets it can from `.env` via `gh secret set` (see §4).

4. First manual bring-up on the VM (the CD does this on every push afterwards):
   ```bash
   export IMAGE_TAG=latest GHCR_OWNER=nikegunn
   docker compose -f compose.yaml -f compose.prod.yaml pull
   docker compose -f compose.yaml -f compose.prod.yaml up -d
   ```
5. Put a TLS reverse proxy (Caddy or nginx) in front, mapping:
   - `api.hisabkitab.pro/mcp`            -> `127.0.0.1:8801` (ledger)
   - `api.hisabkitab.pro/pay`            -> `127.0.0.1:8802` (payments + Khalti return)
   - `api.hisabkitab.pro/webhook`        -> `127.0.0.1:8810` (WhatsApp webhook)
   Then point `LEDGER_MCP_URL` / `PAYMENTS_PUBLIC_BASE_URL` at the public HTTPS URLs.

### Zero-downtime

`compose.prod.yaml` services declare healthchecks; `docker compose up -d` recreates only changed
services and waits for health before removing the old container. The CD `deploy` job runs a
post-deploy health probe on `:8801/:8802/:8810/healthz` and fails the run if any is unhealthy.

---

## 3. Local development with Docker

```bash
pnpm up            # build + run the whole stack (Postgres, Redis, migrate, 3 services)
pnpm down          # stop it
pnpm db:studio     # browse the DB at https://local.drizzle.studio
```

Health: `curl localhost:8801/healthz` (ledger), `:8802` (payments), `:8810` (orchestrator).

---

## 4. CI/CD summary

- **CI** (`ci.yml`, every PR + push): typecheck, lint, full vitest against real Postgres+Redis
  service containers (with the RLS roles), build all 3 images + boot/healthz smoke, Trivy scan.
- **CD** (`cd.yml`, push to `main`): build + push SHA-tagged images to GHCR (with provenance + SBOM),
  then SSH-deploy via `compose.prod.yaml` — **skipped cleanly until `DEPLOY_HOST`/`DEPLOY_SSH_KEY` exist**.
- Works on a **public or private** repo (GHCR auth uses the built-in `GITHUB_TOKEN`).

### Secrets the pipeline sets for you
From your local `.env`, these are pushed to the repo with `gh secret set` (no manual UI needed):
`ANTHROPIC_API_KEY`, `TENANT_SIGNING_SECRET`, `LEDGER_MCP_TOKEN`, `PAYMENTS_MCP_TOKEN`,
`KHALTI_SECRET_KEY`, `WA_*`. The server-only secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`)
you add once you have the VM.
