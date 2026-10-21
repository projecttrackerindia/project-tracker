#!/usr/bin/env bash
# Step 2 (and on every update): builds the app, website and meeting bot from this copy of the code into the Mumbai registry.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
cd ../..
TAG=$(git rev-parse --short HEAD)
# The search-engine verification tags of the website, if Railway had them (railway variables --service FrontEnd --kv > ~/.pt-gcp/railway-web.env).
get() { grep -m1 "^$1=" "$STATE/railway-web.env" 2>/dev/null | cut -d= -f2- || true; }
gcloud builds submit --region="$REGION" --config=deploy/gcp/cloudbuild.yaml \
  --substitutions="_IMAGES=${IMAGES},_TAG=${TAG},_SITE_URL=https://${DOMAIN},_GOOGLE=$(get GOOGLE_SITE_VERIFICATION),_BING=$(get BING_SITE_VERIFICATION),_INDEXNOW=$(get INDEXNOW_KEY)" .
echo "Built ${TAG}. Next (first time): ./3-env.sh   Later updates: ./update.sh"
