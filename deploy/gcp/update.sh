#!/usr/bin/env bash
# Every later release: build the current code, then pull and restart on the server (about a minute of restart for the API).
# The new website's web-server settings are checked first; if they are wrong, nothing restarts and the current version keeps running.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
# Only main goes live: a copy left on a work branch would ship unfinished code. ALLOW_BRANCH=1 overrides it on purpose.
branch=$(git -C ../.. rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ] && [ "${ALLOW_BRANCH:-}" != "1" ]; then
  echo "This copy is on branch '$branch', not main. Run: git -C ~/project-tracker checkout main   (or ALLOW_BRANCH=1 ./update.sh)" >&2; exit 1
fi
# SKIP_BUILD=1 TAG=<tag> only switches the server to images already in the registry (used by the Rollback workflow and rollback.sh).
if [ "${SKIP_BUILD:-}" != "1" ]; then
  git -C ../.. pull --ff-only
  ./2-build.sh
fi
TAG="${TAG:-$(git -C ../.. rev-parse --short HEAD)}"
# The compose file, Caddyfile and release script travel with each release, so changes to them take effect too.
gcloud compute scp --zone="$ZONE" --quiet docker-compose.yml Caddyfile vm-release.sh "$VM_NAME":/tmp/
# vm-release.sh pins TAG in /opt/pt/.env, restarts everything except a meeting bot that is in a meeting, waits for /health/ready
# (the API applies migrations as it starts) and goes back to the previous tag by itself if the new one does not become healthy.
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="set -e; cd /opt/pt && sudo mv /tmp/docker-compose.yml /tmp/Caddyfile /tmp/vm-release.sh /opt/pt/ \
  && sudo bash /opt/pt/vm-release.sh '${TAG}'"
