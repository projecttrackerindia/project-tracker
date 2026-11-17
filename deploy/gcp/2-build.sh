#!/usr/bin/env bash
# Step 2 (and on every update): builds the app, website and meeting bot from this copy of the code into the Mumbai registry.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
cd ../..
TAG="${TAG:-$(git rev-parse --short HEAD)}"
# The search-engine verification tags of the website, if Railway had them (railway variables --service FrontEnd --kv > ~/.pt-gcp/railway-web.env).
get() { grep -m1 "^$1=" "$STATE/railway-web.env" 2>/dev/null | cut -d= -f2- || true; }
# New projects often may not run large build machines in a region yet ("quota restrictions"), so this tries a fast machine first and
# falls back to the standard one. The images always go to the Mumbai registry; only where the build itself runs changes.
SUBS="_IMAGES=${IMAGES},_TAG=${TAG},_ALIAS=${ALIAS:-latest},_SITE_URL=https://${DOMAIN},_GOOGLE=$(get GOOGLE_SITE_VERIFICATION),_BING=$(get BING_SITE_VERIFICATION),_INDEXNOW=$(get INDEXNOW_KEY)"
build() { gcloud builds submit --config=deploy/gcp/cloudbuild.yaml --substitutions="$SUBS" "$@" .; }
# Where the images are built. "local" uses Docker on the machine running this script (GitHub's runner, or Cloud Shell): no
# Cloud Build minutes are billed. "cloud" is the old path on Cloud Build's e2-highcpu-8 machines, kept as a fallback.
# Local needs the deploy account to have Artifact Registry Writer (github-deploy-setup.sh grants it).
BUILD_ON="${BUILD_ON:-local}"
if [ "$BUILD_ON" = "local" ] && ! docker info >/dev/null 2>&1; then
  echo "Docker is not available here; building on Cloud Build instead." >&2; BUILD_ON=cloud
fi
if [ "$BUILD_ON" = "local" ]; then
  gcloud auth configure-docker "${IMAGES%%/*}" --quiet
  A="${ALIAS:-latest}"
  # One image at a time: build, push, then delete it and the build cache. Cloud Shell's disk cannot hold all three at once
  # (the meeting bot alone is ~1.5 GB with its browser), and running out of space mid-build stops the release.
  one() { local img="$1"; shift
    docker build -t "${IMAGES}/${img}:${TAG}" -t "${IMAGES}/${img}:${A}" "$@"
    docker push "${IMAGES}/${img}:${TAG}"; docker push "${IMAGES}/${img}:${A}"
    docker image rm "${IMAGES}/${img}:${TAG}" "${IMAGES}/${img}:${A}" >/dev/null 2>&1 || true
    docker builder prune -af >/dev/null 2>&1 || true; }
  docker system prune -af >/dev/null 2>&1 || true
  one api --build-arg "APP_RELEASE=${TAG}" backend
  one web --build-arg "SITE_URL=https://${DOMAIN}" --build-arg "APP_RELEASE=${TAG}" \
    --build-arg "GOOGLE_SITE_VERIFICATION=$(get GOOGLE_SITE_VERIFICATION)" --build-arg "BING_SITE_VERIFICATION=$(get BING_SITE_VERIFICATION)" \
    --build-arg "INDEXNOW_KEY=$(get INDEXNOW_KEY)" frontend
  one meetbot apps/meetbot
else
build --region="${BUILD_REGION:-$REGION}" --machine-type="${BUILD_MACHINE:-e2-highcpu-8}" \
  || build --region=global --machine-type="${BUILD_MACHINE:-e2-highcpu-8}" \
  || build --region=global
fi
echo "Built ${TAG}. Next (first time): ./3-env.sh   Later updates: ./update.sh"
