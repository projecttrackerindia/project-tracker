#!/usr/bin/env bash
# Runs on the server at every boot: installs Docker the first time, adds swap, and lets Docker pull from the image registry.
set -e
if ! command -v docker >/dev/null; then
  apt-get update && apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile; fi
swapon /swapfile 2>/dev/null || true
REGION=$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone | awk -F/ '{print $NF}' | sed 's/-[a-z]$//')
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
mkdir -p /opt/pt
# Start (or restart) the app once its files are in place.
if [ -f /opt/pt/docker-compose.yml ] && [ -f /opt/pt/.env ]; then cd /opt/pt && docker compose pull -q && docker compose up -d; fi
