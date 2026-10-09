#!/usr/bin/env bash
# Disk guard. Every CD deploy pulls a new SHA-tagged image per service (~3 GB per
# deploy) and nothing removed the old ones, so the disk filled until Postgres would
# have failed to write. Runs daily from cron AND after every deploy (install-ops.sh).
#
# Adaptive, escalating only when needed (thresholds = % of / used):
#   normal     keep images of the newest 3 deploys (current + 2 for rollback)
#   >= WARN    keep 2, clear apt cache, shrink the journal
#   >= CRIT    keep 1 (only what is running), clear build cache, log CRITICAL
# NEVER touched: volumes (Postgres/Redis data), /var/backups, any image a container
# uses (running or stopped). Only ghcr.io/<owner>/hisab-* images are pruned by count.
#
#   DRY_RUN=1 hisab-prune   # print what would happen, change nothing
set -euo pipefail
KEEP="${KEEP:-3}"
WARN="${WARN:-75}"
CRIT="${CRIT:-85}"
DRY_RUN="${DRY_RUN:-0}"
PREFIX='ghcr.io/nikegunn/hisab-'

# One run at a time (cron and a deploy can overlap).
exec 9>/run/lock/hisab-prune.lock
flock -n 9 || { echo "hisab-prune: another run in progress"; exit 0; }

log() {
  local pri=user.info
  if [[ "$1" == -p ]]; then pri="$2"; shift 2; fi
  echo "$*"
  [[ "$DRY_RUN" == 1 ]] || logger -t hisab-prune -p "$pri" "$*"
}
run() { if [[ "$DRY_RUN" == 1 ]]; then echo "would: $*" >&2; else "$@"; fi; }
used_pct() { df --output=pcent / | tail -1 | tr -dc '0-9'; }

docker info >/dev/null 2>&1 || { log -p user.err "docker unreachable, nothing done"; exit 1; }
# Never race a deploy: while compose is pulling/starting, step aside (the deploy runs
# this guard itself right after `up`). Match only processes whose NAME is docker /
# docker-compose (pgrep -x on the process name): a shell script whose command line
# merely CONTAINS "docker compose pull" (exactly how CD runs its deploy script, with
# this guard inside it) must not count, or the post-deploy run would skip itself.
if pgrep -a -x 'docker|docker-compose' | grep -Eq ' (pull|up)( |$)'; then
  log "deploy in progress, skipping (the deploy runs the guard after up)"
  exit 0
fi

# Remove HisabKitab images outside the newest $1 deploys. In-use images are skipped.
prune_deploys() {
  local keep="$1" in_use shas keep_shas ref tag removed=0
  in_use="$(docker ps -a --format '{{.Image}}' | sort -u)"
  mapfile -t shas < <(
    docker images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' \
      | grep -F "|$PREFIX" | sort -r \
      | sed -n 's/.*:\(sha-[0-9a-f]\{7,\}\)$/\1/p' | awk '!seen[$0]++'
  )
  ((${#shas[@]} > 0)) || return 0
  keep_shas=" ${shas[*]:0:$keep} "
  while IFS= read -r ref; do
    tag="${ref##*:}"
    [[ "$keep_shas" == *" $tag "* ]] && continue
    grep -qxF "$ref" <<<"$in_use" && continue
    run docker rmi "$ref" >/dev/null && removed=$((removed + 1))
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -F "$PREFIX" | grep -v ':<none>$')
  run docker image prune -f >/dev/null # dangling layers the removals left behind
  log "keep=$keep removed=$removed kept:${keep_shas}"
}

before="$(used_pct)"

prune_deploys "$KEEP"

if (($(used_pct) >= WARN)); then
  log -p user.warning "disk $(used_pct)% >= ${WARN}%: escalating"
  prune_deploys 2
  run apt-get clean
  run journalctl --vacuum-size=100M >/dev/null 2>&1 || true
fi

if (($(used_pct) >= CRIT)); then
  log -p user.crit "disk $(used_pct)% >= ${CRIT}%: keeping ONLY the running build"
  prune_deploys 1
  run docker builder prune -af >/dev/null 2>&1 || true
fi

after="$(used_pct)"
if ((after >= 90)); then
  log -p user.crit "DISK CRITICAL ${after}% after every safe cleanup: needs a human (resize the disk)"
  exit 1
fi
log "ok disk ${before}% -> ${after}%"
