#!/usr/bin/env bash
# Step 5: puts the settings on the server and starts everything. Then point the domain at the server (see README).
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
for f in api.env meetbot.env compose.env; do [ -s "$STATE/$f" ] || { echo "Missing $STATE/$f - run ./3-env.sh" >&2; exit 1; }; done
echo "Waiting for the server to finish installing Docker..."
until gcloud compute ssh "$VM_NAME" --zone="$ZONE" --command='command -v docker >/dev/null && docker compose version >/dev/null' --quiet 2>/dev/null; do sleep 15; done
gcloud compute scp --zone="$ZONE" docker-compose.yml Caddyfile "$STATE/api.env" "$STATE/meetbot.env" "$STATE/compose.env" "$VM_NAME":/tmp/ --quiet
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='set -e
  sudo mkdir -p /opt/pt && cd /tmp && sudo mv docker-compose.yml Caddyfile api.env meetbot.env /opt/pt/ && sudo mv compose.env /opt/pt/.env
  sudo chmod 600 /opt/pt/api.env /opt/pt/meetbot.env /opt/pt/.env
  cd /opt/pt && sudo docker compose pull -q && sudo docker compose up -d
  for i in $(seq 1 40); do sudo docker compose exec -T web wget -qO- http://api:8080/health/ready >/dev/null 2>&1 && { echo "API is healthy."; break; }; sleep 6; done
  sudo docker compose ps'
IP=$(gcloud compute addresses describe pt-ip --region="$REGION" --format='value(address)')
echo
echo "Running. Now point ${DOMAIN} (A record) to ${IP} at your DNS provider. HTTPS is set up automatically within a minute of the change reaching the internet."
