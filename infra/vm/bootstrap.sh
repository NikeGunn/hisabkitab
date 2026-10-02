#!/usr/bin/env bash
# One-shot, idempotent provisioning of a fresh Ubuntu VM for HisabKitab prod.
# Rebuilds the whole host from the repo so losing a VM never means hand-setup again.
#
#   scp -i hisab.pem infra/vm/* <prod .env> ubuntu@<ip>:/tmp/   (prod .env as /tmp/.env)
#   ssh -i hisab.pem ubuntu@<ip> 'bash /tmp/bootstrap.sh'
#
# Installs: swap, Docker + Compose, Caddy (auto-TLS), ufw (22/80/443), fail2ban,
# unattended-upgrades, nightly DB backup + 5-min health watchdog (cron), then
# clones the repo to /opt/hisabkitab and starts the prod stack from GHCR.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/hisabkitab
REPO=${REPO:-https://github.com/NikeGunn/hisabkitab.git}
PUBLIC_IP=${PUBLIC_IP:-$(curl -fsS -m 10 https://api.ipify.org)}

# --- swap (small-RAM boxes) ---
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-hisab.conf >/dev/null
sudo sysctl -q --system
sudo timedatectl set-timezone Asia/Kathmandu || true

# --- packages ---
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git ufw fail2ban unattended-upgrades jq >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh >/tmp/docker-install.log 2>&1 \
    || sudo apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
fi
echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true}' \
  | sudo tee /etc/docker/daemon.json >/dev/null
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker && sudo systemctl restart docker
command -v caddy >/dev/null || sudo apt-get install -y -qq caddy >/dev/null

# --- firewall + hardening ---
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
for r in 22/tcp 80/tcp 443/tcp 443/udp; do sudo ufw allow "$r" >/dev/null; done
sudo ufw --force enable >/dev/null
sudo systemctl enable --now fail2ban unattended-upgrades

# --- app checkout + secrets ---
sudo mkdir -p "$APP" && sudo chown "$USER:$USER" "$APP"
[ -d "$APP/.git" ] || git clone -q "$REPO" "$APP"
if [ -f /tmp/.env ]; then install -m 600 /tmp/.env "$APP/.env" && rm -f /tmp/.env; fi
[ -f "$APP/.env" ] || { echo "missing $APP/.env (copy the prod .env to /tmp/.env)"; exit 1; }

# --- reverse proxy ---
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sed "s/__SSLIP_HOST__/${PUBLIC_IP//./-}.sslip.io/" "$HERE/Caddyfile" > /tmp/Caddyfile.rendered
sudo caddy validate --config /tmp/Caddyfile.rendered --adapter caddyfile >/dev/null
sudo install -m 644 /tmp/Caddyfile.rendered /etc/caddy/Caddyfile
sudo systemctl enable caddy >/dev/null && sudo systemctl reload-or-restart caddy

# --- ops automation ---
sudo install -m 750 "$HERE/hisab-backup.sh" /usr/local/bin/hisab-backup
sudo install -m 750 "$HERE/hisab-watchdog.sh" /usr/local/bin/hisab-watchdog
printf '30 2 * * * root /usr/local/bin/hisab-backup\n*/5 * * * * root /usr/local/bin/hisab-watchdog\n' \
  | sudo tee /etc/cron.d/hisabkitab >/dev/null

# --- start the stack (CD takes over image tags from here) ---
cd "$APP"
sudo docker compose -f compose.yaml -f compose.prod.yaml pull -q
sudo docker compose -f compose.yaml -f compose.prod.yaml up -d --remove-orphans
echo "bootstrap done: https://${PUBLIC_IP//./-}.sslip.io/healthz"
