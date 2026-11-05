#!/usr/bin/env bash
# From Cloud Shell: put an earlier release back live without building anything.
#   ./rollback.sh            back to the release before the current one
#   ./rollback.sh 1a2b3c4    to that exact tag (a short commit id; see: gcloud artifacts docker tags list $IMAGES/api)
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG=$(gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='sudo bash /opt/pt/vm-release.sh --previous' | tr -d '\r')
  [ -n "$TAG" ] || { echo "The server does not know a previous release; give a tag." >&2; exit 1; }
fi
gcloud artifacts docker tags list "${IMAGES}/api" --format='value(tag.basename())' | grep -qx "$TAG" || { echo "No api image tagged $TAG in ${IMAGES}." >&2; exit 1; }
echo "Rolling back to $TAG"
SKIP_BUILD=1 ALLOW_BRANCH=1 TAG="$TAG" ./update.sh
