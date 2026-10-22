#!/usr/bin/env bash
# Every later release: build the current code, then pull and restart on the server (about a minute of restart for the API).
# The new website's web-server settings are checked first; if they are wrong, nothing restarts and the current version keeps running.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
git -C ../.. pull --ff-only
./2-build.sh
# The compose file and Caddyfile travel with each release, so changes to them take effect too.
gcloud compute scp --zone="$ZONE" --quiet docker-compose.yml Caddyfile "$VM_NAME":/tmp/
# Everything restarts at once except the meeting bot: a bot in a meeting must not be cut off by a release. If it is in a meeting,
# a small job on the server waits until it is free (checking every minute, up to 4 hours) and only then moves it to the new version.
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='set -e; cd /opt/pt && sudo mv /tmp/docker-compose.yml /tmp/Caddyfile /opt/pt/ \
  && sudo docker compose pull -q && sudo docker compose run --rm --no-deps -T web nginx -t \
  && sudo docker compose up -d $(sudo docker compose config --services | grep -v "^meetbot$") \
  && busy() { sudo docker compose exec -T meetbot node -e "fetch(\"http://localhost:8080/health\").then(r=>r.json()).then(j=>console.log(j.bots||0)).catch(()=>console.log(0))" 2>/dev/null || echo 0; } \
  && if [ "$(busy)" = "0" ]; then sudo docker compose up -d meetbot; echo "meeting bot updated"; \
     else echo "meeting bot is in a meeting: it moves to the new version when the meeting ends"; \
       sudo nohup sh -c "for i in \$(seq 240); do b=\$(docker compose exec -T meetbot node -e \"fetch(\\\"http://localhost:8080/health\\\").then(r=>r.json()).then(j=>console.log(j.bots||0)).catch(()=>console.log(0))\" 2>/dev/null || echo 0); [ \"\$b\" = 0 ] && break; sleep 60; done; docker compose up -d meetbot" >/tmp/meetbot-update.log 2>&1 & fi \
  && sudo docker image prune -f >/dev/null && sudo docker compose ps'
