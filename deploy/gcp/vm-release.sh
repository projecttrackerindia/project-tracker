#!/usr/bin/env bash
# Runs ON the server (copied to /opt/pt by update.sh and the GitHub Deploy/Rollback workflows):
#   sudo bash /opt/pt/vm-release.sh <tag>          puts images <tag> live; on a failed health check it goes back to the previous tag
#   sudo bash /opt/pt/vm-release.sh --current      prints the tag that is live
#   sudo bash /opt/pt/vm-release.sh --previous     prints the tag that was live before it (the one a rollback returns to)
# The live tag is pinned as TAG=... in /opt/pt/.env, so a plain `docker compose up -d` later keeps the same version.
# Database migrations are applied by the API itself when it starts (Database:AutoMigrate), and /health/ready only answers once
# the database is reachable, so "healthy" here means "migrated and serving".
# Environment: NO_ROLLBACK=1 skips the automatic return; HEALTH_TRIES (default 30, 10 s apart).
set -euo pipefail
cd "${PT_DIR:-/opt/pt}"
ENV_FILE=.env
current_tag() {
  local t; t=$(grep -m1 '^TAG=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  if [ -z "$t" ] || [ "$t" = latest ]; then
    # "latest" is not something to roll back to: find the real tag of the image the API runs now.
    local id; id=$(docker compose ps -q api 2>/dev/null | head -1)
    if [ -n "$id" ]; then
      t=$(docker image inspect "$(docker inspect --format '{{.Image}}' "$id")" --format '{{join .RepoTags "\n"}}' 2>/dev/null \
          | sed -n 's#.*/api:##p' | grep -v '^latest$' | head -1 || true)
    fi
  fi
  echo "${t:-}"
}
case "${1:-}" in
  --current) current_tag; exit 0 ;;
  --previous) cat .release.prev 2>/dev/null || true; exit 0 ;;
  ""|-*) echo "usage: vm-release.sh <tag>|--current|--previous" >&2; exit 2 ;;
esac
TAG_NEW="$1"
[[ "$TAG_NEW" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "Not a valid image tag: $TAG_NEW" >&2; exit 2; }

set_tag() { if grep -q '^TAG=' "$ENV_FILE"; then sed -i "s/^TAG=.*/TAG=$1/" "$ENV_FILE"; else echo "TAG=$1" >> "$ENV_FILE"; fi; }
healthy() {
  # From inside the web container (busybox wget) so it needs neither DNS nor the certificate; the workflow also checks from outside.
  for _ in $(seq "${HEALTH_TRIES:-30}"); do
    docker compose exec -T web wget -q -T 5 -O /dev/null http://api:8080/health/ready 2>/dev/null && return 0
    sleep 10
  done
  return 1
}
meetbot_busy() { docker compose exec -T meetbot node -e 'fetch("http://localhost:8080/health").then(r=>r.json()).then(j=>console.log(j.bots||0)).catch(()=>console.log(0))' 2>/dev/null || echo 0; }

go_live() {
  local tag="$1"
  set_tag "$tag"
  docker compose pull -q
  docker compose run --rm --no-deps -T web nginx -t
  # Everything restarts at once except the meeting bot: a bot in a meeting must not be cut off by a release.
  docker compose up -d $(docker compose config --services | grep -v '^meetbot$')
}

PREV=$(current_tag)
echo "Live now: ${PREV:-unknown}. Releasing: $TAG_NEW"
if ! go_live "$TAG_NEW" || ! healthy; then
  echo "Release $TAG_NEW is not healthy." >&2
  if [ -n "$PREV" ] && [ "$PREV" != "$TAG_NEW" ] && [ "${NO_ROLLBACK:-}" != 1 ]; then
    echo "Going back to $PREV." >&2
    go_live "$PREV" && healthy && echo "Back on $PREV." >&2 || echo "The previous release $PREV is not healthy either: look at docker compose logs api." >&2
  fi
  exit 3
fi
[ -n "$PREV" ] && [ "$PREV" != "$TAG_NEW" ] && echo "$PREV" > .release.prev
echo "$TAG_NEW" > .release

if ! docker compose config --services | grep -qx meetbot; then :   # not run here (staging)
elif [ "$(meetbot_busy)" = 0 ]; then docker compose up -d meetbot; echo "meeting bot updated"
else
  echo "meeting bot is in a meeting: it moves to the new version when the meeting ends"
  nohup sh -c 'for i in $(seq 240); do b=$(docker compose exec -T meetbot node -e "fetch(\"http://localhost:8080/health\").then(r=>r.json()).then(j=>console.log(j.bots||0)).catch(()=>console.log(0))" 2>/dev/null || echo 0); [ "$b" = 0 ] && break; sleep 60; done; docker compose up -d meetbot' >/tmp/meetbot-update.log 2>&1 &
fi
docker image prune -f >/dev/null
docker compose ps
echo "Live: $TAG_NEW (previous: ${PREV:-none})"
