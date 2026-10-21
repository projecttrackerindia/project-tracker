#!/usr/bin/env bash
# Step 2 (and on every update): builds the app, website and meeting bot from this copy of the code into the Mumbai registry.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
cd ../..
TAG=$(git rev-parse --short HEAD)
# The search-engine verification tags of the website, if Railway had them (railway variables --service FrontEnd --kv > ~/.pt-gcp/railway-web.env).
get() { grep -m1 "^$1=" "$STATE/railway-web.env" 2>/dev/null | cut -d= -f2- || true; }
# New projects often may not run large build machines in a region yet ("quota restrictions"), so this tries a fast machine first and
# falls back to the standard one. The images always go to the Mumbai registry; only where the build itself runs changes.
SUBS="_IMAGES=${IMAGES},_TAG=${TAG},_SITE_URL=https://${DOMAIN},_GOOGLE=$(get GOOGLE_SITE_VERIFICATION),_BING=$(get BING_SITE_VERIFICATION),_INDEXNOW=$(get INDEXNOW_KEY)"
build() { gcloud builds submit --config=deploy/gcp/cloudbuild.yaml --substitutions="$SUBS" "$@" .; }
build --region="${BUILD_REGION:-$REGION}" --machine-type="${BUILD_MACHINE:-e2-highcpu-8}" \
  || build --region=global --machine-type="${BUILD_MACHINE:-e2-highcpu-8}" \
  || build --region=global
echo "Built ${TAG}. Next (first time): ./3-env.sh   Later updates: ./update.sh"
