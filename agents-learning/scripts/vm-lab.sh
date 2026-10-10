#!/usr/bin/env bash
# Run the lab CLI inside its existing container; no Node/pnpm needed on the VM.
# Usage: bash agents-learning/scripts/vm-lab.sh enqueue --agent careful --split golden --budget-rs 0
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
docker compose -f compose.yaml -f compose.prod.yaml exec -T lab-worker \
  pnpm --filter @hisab/rehearsal lab "$@"
