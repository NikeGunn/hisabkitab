#!/usr/bin/env bash
# Install gVisor (runsc) and register it as a Docker runtime — for the Rehearsal Lab
# worker only (compose: runtime: ${LAB_RUNTIME}). Idempotent. No downtime: Docker's
# `runtimes` config is hot-reloaded on SIGHUP, so running containers are untouched.
#
#   sudo bash infra/vm/install-gvisor.sh
#   then in /opt/hisabkitab/.env:  LAB_RUNTIME=runsc
#
# gVisor = a user-space kernel: the container's syscalls hit gVisor's Sentry, not the
# host kernel, which shrinks the kernel attack surface if a container is compromised.
set -euo pipefail

if ! command -v runsc >/dev/null 2>&1; then
  ARCH=$(uname -m)
  URL=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  ( cd "$tmp"
    curl -fsSLO "${URL}/runsc" -O "${URL}/runsc.sha512"
    sha512sum -c runsc.sha512            # refuse a tampered download
    install -m 0755 runsc /usr/local/bin/runsc )
fi

runsc --version
# Writes the runsc entry into /etc/docker/daemon.json (keeps existing keys).
/usr/local/bin/runsc install
systemctl reload docker

# Prove it: the kernel a runsc container sees is gVisor's, not the host's.
if docker run --rm --runtime=runsc busybox:1.36 dmesg 2>/dev/null | grep -qi gvisor; then
  echo "gVisor OK: containers with runtime=runsc run on the gVisor kernel"
else
  echo "gVisor runtime registered but the probe container did not report gVisor" >&2
  exit 1
fi
