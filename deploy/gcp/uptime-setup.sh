#!/usr/bin/env bash
# Once (safe to re-run), in Cloud Shell: Google Cloud uptime checks every minute from several regions, and one alert policy that
# emails ALERT_EMAIL when any check fails for 2 minutes (and again when it recovers).
#   ALERT_EMAIL=ops@example.com ./uptime-setup.sh
# WhatsApp alerts come from the GitHub "Uptime" workflow (deploy/ops/send-alert.sh), because a relay inside the app cannot
# speak while the app is down. Optional: ALERT_SMS / extra channels can be added in Monitoring › Alerting › Notification channels.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
: "${ALERT_EMAIL:?set ALERT_EMAIL=address that receives outage emails}"
HOST="${UPTIME_HOST:-$DOMAIN}"
gcloud services enable monitoring.googleapis.com >/dev/null

echo "== Email channel ${ALERT_EMAIL}"
CH=$(gcloud beta monitoring channels list --filter="type=\"email\" AND labels.email_address=\"${ALERT_EMAIL}\"" --format='value(name)' | head -1)
[ -n "$CH" ] || CH=$(gcloud beta monitoring channels create --display-name="ProjectTracker ops (${ALERT_EMAIL})" --type=email \
  --channel-labels=email_address="$ALERT_EMAIL" --format='value(name)')

# name | path | text the answer must contain ("" = only status 200)
CHECKS="pt-ready|/health/ready|Healthy
pt-web|/|<div id=\"root\"
pt-api|/api/v1/platform/status|
pt-auth|/api/v1/auth/password-policy|"
while IFS='|' read -r name path needle; do
  if gcloud monitoring uptime list-configs --filter="displayName=\"$name\"" --format='value(name)' | grep -q .; then echo "== $name exists"; continue; fi
  echo "== Uptime check $name: https://${HOST}${path}"
  args=(--resource-type=uptime-url --resource-labels="host=${HOST},project_id=${PROJECT_ID}" --protocol=https --path="$path"
        --port=443 --period=1 --timeout=10 --validate-ssl=true --status-codes=200)
  [ -n "$needle" ] && args+=(--matcher-content="$needle" --matcher-type=contains-string)
  gcloud monitoring uptime create "$name" "${args[@]}" >/dev/null
done <<<"$CHECKS"

echo "== Alert policy"
if ! gcloud alpha monitoring policies list --filter='displayName="ProjectTracker is down"' --format='value(name)' | grep -q .; then
  f=$(mktemp); cat > "$f" <<JSON
{
  "displayName": "ProjectTracker is down",
  "combiner": "OR",
  "documentation": {"content": "A ProjectTracker uptime check (${HOST}) is failing from 2+ regions. Runbook: docs/ops.md › Uptime. Rollback: GitHub Actions › Rollback.", "mimeType": "text/markdown"},
  "conditions": [{
    "displayName": "Uptime check failing",
    "conditionThreshold": {
      "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=starts_with(\"pt-\")",
      "aggregations": [{"alignmentPeriod": "60s", "perSeriesAligner": "ALIGN_NEXT_OLDER", "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.label.host", "metric.label.check_id"]}],
      "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "120s",
      "trigger": {"count": 1}
    }
  }],
  "alertStrategy": {"autoClose": "1800s"},
  "notificationChannels": ["${CH}"]
}
JSON
  gcloud alpha monitoring policies create --policy-from-file="$f" >/dev/null; rm -f "$f"
fi
echo "Done: checks every minute; email to ${ALERT_EMAIL} after 2 failing minutes. See Monitoring › Uptime checks."
