#!/usr/bin/env bash
# Install gVisor (runsc) and register it as a Docker runtime — for the Rehearsal Lab
# worker only (compose: runtime: ${LAB_RUNTIME}). Idempotent. No downtime: Docker's
# `runtimes` config is hot-reloaded on SIGHUP, so running containers are untouched.
#
#   sudo bash infra/vm/install-gvisor.sh
#   then in /opt/hisabkitab/.env:  LAB_RUNTIME=runsc-docker
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
    # Current releases bundle runsc and its required sidecar binaries together.
    curl -fsSLO "${URL}/gvisor.tar.bz2" -O "${URL}/gvisor.tar.bz2.sha512"
    sha512sum -c gvisor.tar.bz2.sha512    # refuse a tampered download
    tar -xjf gvisor.tar.bz2 -C /usr/local/bin )
fi

runsc --version
# Writes the runsc entry into /etc/docker/daemon.json (keeps existing keys).
/usr/local/bin/runsc install
# Docker Compose's embedded DNS is unreachable from gVisor's default netstack.
# Register a separate runtime using host sockets IN Docker's network namespace.
# This retains the Compose bridge, but uses the host network stack rather than
# gVisor netstack (a narrower security boundary). Never change Docker's default.
/usr/local/bin/runsc install --runtime=runsc-docker -- --network=host
systemctl reload docker
# SIGHUP returns before Docker finishes loading the new runtime registry.
for attempt in {1..10}; do
  if docker info --format '{{json .Runtimes}}' | grep '"runsc-docker"' >/dev/null; then
    break
  fi
  sleep 1
done

# Prove it: the kernel a runsc container sees is gVisor's, not the host's.
# Read the whole output: grep -q can close stdout early, making Docker fail with
# a broken pipe under pipefail even when the runtime is healthy.
if docker run --rm --runtime=runsc-docker "${GVISOR_PROBE_IMAGE:-busybox:1.36}" dmesg | grep -i gvisor >/dev/null; then
  echo "gVisor OK: containers with runtime=runsc-docker run on the gVisor kernel"
else
  echo "gVisor runtime registered but the probe container did not report gVisor" >&2
  exit 1
fi
