#!/usr/bin/env bash
# Every 5 min: restart any service whose /healthz fails twice. Never changes
# image tags (CD owns those) — only restarts the existing container.
for target in ledger:8801 payments:8802 tally:8803 orchestrator:8810; do
  svc=${target%%:*}; port=${target##*:}
  curl -fsS -m 5 http://127.0.0.1:$port/healthz >/dev/null 2>&1 && continue
  sleep 10
  curl -fsS -m 5 http://127.0.0.1:$port/healthz >/dev/null 2>&1 && continue
  logger -t hisab-watchdog "$svc :$port unhealthy -> restart"
  docker restart "hisabkitab-$svc-1" >/dev/null 2>&1 || logger -t hisab-watchdog "restart $svc FAILED"
done
