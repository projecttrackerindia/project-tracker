#!/usr/bin/env bash
# Our own video calls: sets up the media server (LiveKit) on its own machine in Mumbai, at calls.<your domain>, and connects the app to it.
# Run it in Cloud Shell after the app itself is running (steps 1-5). Safe to run again: what exists is kept, including the keys.
#
#   cd ~/project-tracker/deploy/gcp && ./calls.sh
#
# What it does:
#   1. A fixed public address and the firewall openings a media server needs (web, signalling and the video itself).
#   2. You add one DNS record: calls.<domain> -> that address. The script waits until it is visible.
#   3. The server (pt-calls): it has no Google account of its own and no access to anything else in the project.
#   4. Its keys: made here once, kept in ~/.pt-gcp (never in git), copied to the media server and to the app.
#   5. HTTPS for calls.<domain> (Caddy, automatic), then the media server, which reports who joins and leaves to
#      https://<domain>/api/v1/calls/livekit (signed with those keys).
#   6. The app learns where calls live (API, website and meeting bot settings) and restarts the API and website (about a minute).
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh

CALLS_VM="${CALLS_VM:-pt-calls}"
CALLS_VM_TYPE="${CALLS_VM_TYPE:-e2-standard-2}"     # 2 vCPU, 8 GB: comfortably dozens of people in calls at once; see docs/VIDEO-CALLS.md to grow
CALLS_HOST="calls.${DOMAIN}"
MAX_PARTICIPANTS="${MAX_PARTICIPANTS:-50}"

echo "== Fixed public address for ${CALLS_HOST}"
gcloud compute addresses describe pt-calls-ip --region="$REGION" >/dev/null 2>&1 || gcloud compute addresses create pt-calls-ip --region="$REGION"
IP=$(gcloud compute addresses describe pt-calls-ip --region="$REGION" --format='value(address)')

echo "== Firewall: HTTPS, signalling over TCP, TURN, and the video ports"
gcloud compute firewall-rules describe pt-calls >/dev/null 2>&1 || \
  gcloud compute firewall-rules create pt-calls --target-tags=pt-calls --description="ProjectTracker calls: HTTPS, ICE/TCP, TURN, media" \
    --allow=tcp:80,tcp:443,tcp:7881,tcp:5349,udp:3478,udp:30000-40000,udp:50000-60000

echo "== Keys for the media server (kept in $STATE)"
if [ ! -s "$STATE/calls-key" ] || [ ! -s "$STATE/calls-secret" ]; then
  printf 'PT%s' "$(openssl rand -hex 8)" > "$STATE/calls-key"
  openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48 > "$STATE/calls-secret"
  chmod 600 "$STATE/calls-key" "$STATE/calls-secret"
fi
LK_KEY=$(cat "$STATE/calls-key"); LK_SECRET=$(cat "$STATE/calls-secret")

echo
echo "== DNS: add this record at your DNS provider (if it is not there yet)"
echo "     ${CALLS_HOST}   A   ${IP}"
printf "Waiting until it is visible on the internet"
for i in $(seq 1 120); do
  [ "$(dig +short "$CALLS_HOST" @8.8.8.8 2>/dev/null | tail -1)" = "$IP" ] && { echo " - found."; break; }
  [ "$i" = 120 ] && { echo; echo "Still not visible after 40 minutes. Check the record, then run ./calls.sh again." >&2; exit 1; }
  printf "."; sleep 20
done

echo "== The calls server ($CALLS_VM, $CALLS_VM_TYPE)"
if ! gcloud compute instances describe "$CALLS_VM" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$CALLS_VM" --zone="$ZONE" --machine-type="$CALLS_VM_TYPE" \
    --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=20GB --boot-disk-type=pd-balanced \
    --address="$IP" --network-tier=PREMIUM --tags=pt-calls \
    --no-service-account --no-scopes \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata-from-file=startup-script=calls/vm-startup.sh
else
  # Keep the start-up steps current (a newer media server version, for instance); they run at the next boot or below.
  gcloud compute instances add-metadata "$CALLS_VM" --zone="$ZONE" --metadata-from-file=startup-script=calls/vm-startup.sh >/dev/null
fi
echo "Waiting for the server to install Docker and the media server..."
until gcloud compute ssh "$CALLS_VM" --zone="$ZONE" --quiet --command='command -v docker >/dev/null && docker compose version >/dev/null && test -x /usr/local/bin/livekit-server' 2>/dev/null; do sleep 15; done

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
umask 077
cat > "$T/calls.env" <<ENV
DOMAIN=${DOMAIN}
LK_KEY=${LK_KEY}
LK_SECRET=${LK_SECRET}
MAX_PARTICIPANTS=${MAX_PARTICIPANTS}
ENV
printf 'CALLS_HOST=%s\nACME_EMAIL=%s\n' "$CALLS_HOST" "$ACME_EMAIL" > "$T/.env"
gcloud compute scp --zone="$ZONE" --quiet calls/docker-compose.yml calls/Caddyfile calls/apply.sh calls/vm-startup.sh "$T/calls.env" "$T/.env" "$CALLS_VM":/tmp/
gcloud compute ssh "$CALLS_VM" --zone="$ZONE" --quiet --command="set -e
  sudo mkdir -p /opt/calls && cd /tmp && sudo mv docker-compose.yml Caddyfile apply.sh calls.env .env /opt/calls/
  sudo chmod 700 /opt/calls/apply.sh && sudo chmod 600 /opt/calls/calls.env /opt/calls/.env
  sudo bash /tmp/vm-startup.sh >/dev/null && rm -f /tmp/vm-startup.sh
  cd /opt/calls && sudo docker compose pull -q && sudo docker compose up -d
  echo 'Waiting for the HTTPS certificate for ${CALLS_HOST}...'
  for i in \$(seq 1 36); do sudo test -s /opt/calls/caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${CALLS_HOST}/${CALLS_HOST}.crt && break; sleep 5; done
  sudo /opt/calls/apply.sh
  for i in \$(seq 1 20); do curl -fsS http://127.0.0.1:7880/ >/dev/null 2>&1 && { echo 'Media server is up.'; break; }; sleep 3; done"

echo "== Checking https://${CALLS_HOST} from here"
for i in $(seq 1 20); do curl -fsS "https://${CALLS_HOST}/" >/dev/null 2>&1 && { echo "Reachable over HTTPS."; break; }; [ "$i" = 20 ] && echo "Not reachable over HTTPS yet - the certificate may still be on its way; run ./calls.sh again in a few minutes." >&2; sleep 6; done

echo "== Telling the app where calls live"
for f in api.env meetbot.env compose.env; do [ -s "$STATE/$f" ] || { echo "Missing $STATE/$f - run ./3-env.sh first." >&2; exit 1; }; done
set_kv() { # file key value: replace the line for key, or add it
  local f="$1" k="$2" v="$3"
  grep -v "^${k}=" "$f" > "$f.tmp" || true
  printf '%s=%s\n' "$k" "$v" >> "$f.tmp" && mv "$f.tmp" "$f" && chmod 600 "$f"
}
set_kv "$STATE/api.env" Calls__Url "wss://${CALLS_HOST}"
set_kv "$STATE/api.env" Calls__ApiUrl "https://${CALLS_HOST}"
set_kv "$STATE/api.env" Calls__ApiKey "$LK_KEY"
set_kv "$STATE/api.env" Calls__ApiSecret "$LK_SECRET"
set_kv "$STATE/api.env" Calls__MaxParticipants "$MAX_PARTICIPANTS"
set_kv "$STATE/meetbot.env" MEETBOT_LIVEKIT_HOSTS "$CALLS_HOST"
set_kv "$STATE/compose.env" CALLS_ORIGIN "\"wss://${CALLS_HOST} https://${CALLS_HOST}\""
gcloud compute scp --zone="$ZONE" --quiet "$STATE/api.env" "$STATE/meetbot.env" "$STATE/compose.env" "$VM_NAME":/tmp/
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='set -e
  cd /tmp && sudo mv api.env meetbot.env /opt/pt/ && sudo mv compose.env /opt/pt/.env && sudo chmod 600 /opt/pt/api.env /opt/pt/meetbot.env /opt/pt/.env
  cd /opt/pt && sudo docker compose up -d api web
  busy=$(sudo docker compose exec -T meetbot node -e "fetch(\"http://localhost:8080/health\").then(r=>r.json()).then(j=>console.log(j.bots||0)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
  if [ "$busy" = "0" ]; then sudo docker compose up -d meetbot; else echo "The meeting bot is in a meeting: it picks up the calls setting at its next restart (./update.sh)."; fi
  for i in $(seq 1 40); do sudo docker compose exec -T web wget -qO- http://api:8080/health/ready >/dev/null 2>&1 && { echo "API is healthy."; break; }; sleep 6; done'

echo
echo "Done. Video calls are on: a Call button appears in projects and chats."
echo "Media server: https://${CALLS_HOST}   Keys: $STATE/calls-key, $STATE/calls-secret   Notes: docs/VIDEO-CALLS.md"
echo "If you ever run ./3-env.sh again, run ./calls.sh after it: 3-env.sh rewrites the app settings."
