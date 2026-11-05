#!/usr/bin/env bash
# Checks (read-only) that Cloud SQL keeps the backups docs/ops.md promises; FIX=1 applies the expected settings.
#   ./backups-verify.sh          prints the settings and the newest backups; exits 1 if something is off
#   FIX=1 ./backups-verify.sh    patches the instance to: daily backups at 20:30 UTC (02:00 IST), 14 kept, point-in-time recovery 7 days
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
WANT_KEEP="${WANT_KEEP:-14}"; WANT_PITR_DAYS="${WANT_PITR_DAYS:-7}"
read -r enabled pitr keep logs start <<<"$(gcloud sql instances describe "$DB_INSTANCE" --format='value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled,settings.backupConfiguration.backupRetentionSettings.retainedBackups,settings.backupConfiguration.transactionLogRetentionDays,settings.backupConfiguration.startTime)' | tr '\t' ' ')"
echo "Cloud SQL ${DB_INSTANCE}: backups=${enabled:-?} start=${start:-?}Z kept=${keep:-?} point-in-time=${pitr:-?} log-days=${logs:-?}"
problems=()
[ "${enabled,,}" = true ] || problems+=("automated backups are off")
[ "${pitr,,}" = true ] || problems+=("point-in-time recovery is off")
[ "${keep:-0}" -ge "$WANT_KEEP" ] || problems+=("only ${keep:-0} backups kept (want $WANT_KEEP)")
[ "${logs:-0}" -ge "$WANT_PITR_DAYS" ] || problems+=("transaction logs kept ${logs:-0} days (want $WANT_PITR_DAYS)")
echo "Newest backups:"
gcloud sql backups list --instance="$DB_INSTANCE" --limit=5 --format='table(id,windowStartTime,status,type)'
last_ok=$(gcloud sql backups list --instance="$DB_INSTANCE" --filter='status=SUCCESSFUL' --limit=1 --format='value(windowStartTime)')
if [ -z "$last_ok" ]; then problems+=("no successful backup found")
else
  age_h=$(( ( $(date -u +%s) - $(date -u -d "$last_ok" +%s) ) / 3600 ))
  echo "Last successful backup: $last_ok (${age_h} h ago)"
  [ "$age_h" -le 30 ] || problems+=("last successful backup is ${age_h} h old")
fi
if [ ${#problems[@]} -eq 0 ]; then echo "Backups: OK"; exit 0; fi
printf 'Problem: %s\n' "${problems[@]}" >&2
if [ "${FIX:-}" = 1 ]; then
  gcloud sql instances patch "$DB_INSTANCE" --quiet --backup-start-time=20:30 --retained-backups-count="$WANT_KEEP" \
    --enable-point-in-time-recovery --retained-transaction-log-days="$WANT_PITR_DAYS"
  echo "Patched. Re-run without FIX to confirm."
fi
exit 1
