#!/usr/bin/env bash
# Monthly restore test: restores the newest successful backup of pt-db into a TEMPORARY instance, checks the data is really there,
# then deletes the temporary instance (also on failure). Production is only read (its backup list), never changed.
#   ./restore-test.sh                (Cloud Shell, or the GitHub "Restore test" workflow)
# Checks: the schema has its tables, the EF migrations history is present, and the key tables (Tenants, Users, Projects, Tasks)
# have at least MIN_ROWS rows (default 1). Results are printed as a small table; exit 1 if any check fails.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
TMP="pt-restore-test-$(date -u +%Y%m%d%H%M)"
MIN_ROWS="${MIN_ROWS:-1}"
BACKUP=$(gcloud sql backups list --instance="$DB_INSTANCE" --filter='status=SUCCESSFUL' --limit=1 --format='value(id)')
[ -n "$BACKUP" ] || { echo "No successful backup of $DB_INSTANCE to restore." >&2; exit 1; }
read -r VERSION TIER <<<"$(gcloud sql instances describe "$DB_INSTANCE" --format='value(databaseVersion,settings.tier)' | tr '\t' ' ')"
cleanup() {
  [ -n "${PROXY:-}" ] && kill "$PROXY" 2>/dev/null || true
  echo "== Deleting $TMP"; gcloud sql instances delete "$TMP" --quiet --async >/dev/null 2>&1 || echo "::warning::could not delete $TMP; delete it by hand"
}
trap cleanup EXIT

echo "== Temporary instance $TMP ($VERSION, $TIER, no backups of its own)"
gcloud sql instances create "$TMP" --database-version="$VERSION" --edition=ENTERPRISE --tier="${RESTORE_TIER:-$TIER}" --region="$REGION" \
  --storage-type=SSD --storage-size=10 --no-backup --availability-type=zonal --labels=purpose=restore-test --quiet >/dev/null
echo "== Restoring backup $BACKUP of $DB_INSTANCE into $TMP"
gcloud sql backups restore "$BACKUP" --restore-instance="$TMP" --backup-instance="$DB_INSTANCE" --quiet >/dev/null

# A throwaway password on the TEMPORARY instance's postgres user: no production secret is needed or exposed.
PW=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
gcloud sql users set-password postgres --instance="$TMP" --password="$PW" --quiet >/dev/null
P="${STATE}/cloud-sql-proxy"
[ -x "$P" ] || { curl -sSL -o "$P" https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64; chmod +x "$P"; }
"$P" --port 6544 --token "$(gcloud auth print-access-token)" "$(gcloud sql instances describe "$TMP" --format='value(connectionName)')" >"$STATE/restore-proxy.log" 2>&1 &
PROXY=$!; sleep 6
q() { PGPASSWORD="$PW" psql -h 127.0.0.1 -p 6544 -U postgres -d "$DB_NAME" -tAc "$1"; }

fail=0
row() { printf '%-28s %10s  %s\n' "$1" "$2" "$3"; [ "$3" = ok ] || fail=1; }
echo; row "check" "value" "result"
tables=$(q "select count(*) from information_schema.tables where table_schema='public'")
row "tables" "$tables" "$([ "$tables" -ge 20 ] && echo ok || echo FAIL)"
mig=$(q 'select "MigrationId" from "__EFMigrationsHistory" order by "MigrationId" desc limit 1' || echo "")
row "latest migration" "${mig:0:10}" "$([ -n "$mig" ] && echo ok || echo FAIL)"
for t in Tenants Users Projects Tasks; do
  n=$(q "select count(*) from \"$t\"" || echo -1)
  row "rows in $t" "$n" "$([ "$n" -ge "$MIN_ROWS" ] && echo ok || echo FAIL)"
done
echo
[ "$fail" = 0 ] && echo "Restore test PASSED (backup $BACKUP)." || { echo "Restore test FAILED (backup $BACKUP)." >&2; exit 1; }
