#!/usr/bin/env bash
# Install / refresh the host ops automation from the repo: backup, watchdog, disk
# guard, their cron schedule, and the journald size cap. Idempotent. Run by
# bootstrap.sh on a new VM AND by every CD deploy, so the host can never drift from
# the repo (a fix to any of these scripts goes live on the next deploy).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

for s in backup watchdog prune; do
  sed 's/\r$//' "$HERE/hisab-$s.sh" > "/tmp/hisab-$s" # tolerate a CRLF checkout
  bash -n "/tmp/hisab-$s"                              # never install a broken script
  sudo install -m 750 "/tmp/hisab-$s" "/usr/local/bin/hisab-$s"
  rm -f "/tmp/hisab-$s"
done

printf '%s\n' \
  '30 2 * * * root /usr/local/bin/hisab-backup' \
  '15 3 * * * root /usr/local/bin/hisab-prune' \
  '*/5 * * * * root /usr/local/bin/hisab-watchdog' \
  | sudo tee /etc/cron.d/hisabkitab >/dev/null
sudo chmod 644 /etc/cron.d/hisabkitab

# Cap the system journal so logs can never fill the disk either.
want=$'[Journal]\nSystemMaxUse=200M'
if [[ "$(cat /etc/systemd/journald.conf.d/hisab.conf 2>/dev/null)" != "$want" ]]; then
  sudo mkdir -p /etc/systemd/journald.conf.d
  printf '%s\n' "$want" | sudo tee /etc/systemd/journald.conf.d/hisab.conf >/dev/null
  sudo systemctl restart systemd-journald # only when the cap actually changed
fi

echo "ops installed: backup 02:30, prune 03:15 + after each deploy, watchdog */5, journal <= 200M"
