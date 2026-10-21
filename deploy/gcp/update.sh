#!/usr/bin/env bash
# Every later release: build the current code, then pull and restart on the server (about a minute of restart for the API).
# The new website's web-server settings are checked first; if they are wrong, nothing restarts and the current version keeps running.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
git -C ../.. pull --ff-only
./2-build.sh
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='cd /opt/pt && sudo docker compose pull -q && sudo docker compose run --rm --no-deps -T web nginx -t && sudo docker compose up -d && sudo docker image prune -f >/dev/null && sudo docker compose ps'
