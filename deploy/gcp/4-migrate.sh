#!/usr/bin/env bash
# Step 4 (the move): copies the database, uploaded files and call recordings from Railway to Google Cloud.
# Before running: in ProjectTracker, Admin > Settings, turn on Maintenance mode (people can still read; changes pause).
# Also export the Railway database address (stays in your Cloud Shell):
#   railway variables --service Postgres --kv > ~/.pt-gcp/railway-postgres.env
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
get() { grep -m1 "^$1=" "$2" 2>/dev/null | cut -d= -f2- || true; }
SRC_DB=$(get DATABASE_PUBLIC_URL "$STATE/railway-postgres.env")
[ -n "$SRC_DB" ] || { echo "Missing DATABASE_PUBLIC_URL in $STATE/railway-postgres.env" >&2; exit 1; }
# REHEARSAL=1 makes a trial copy while the site stays live (only reads from Railway) and empties Cloud SQL first, so the real
# move later is a known quantity; the real move then copies everything again (files only fetch what changed).
if [ "${FILES_ONLY:-0}" = 1 ]; then
  echo "Files and recordings only."
elif [ "${REHEARSAL:-0}" = 1 ]; then
  echo "Rehearsal: Railway is only read; Cloud SQL's copy is replaced."
  gcloud sql databases delete "$DB_NAME" --instance="$DB_INSTANCE" --quiet >/dev/null 2>&1 || true
  gcloud sql databases create "$DB_NAME" --instance="$DB_INSTANCE" >/dev/null
else
  read -r -p "Is Maintenance mode ON in ProjectTracker (Admin > Settings)? Type yes to continue: " ok; [ "$ok" = "yes" ] || exit 1
  gcloud sql databases delete "$DB_NAME" --instance="$DB_INSTANCE" --quiet >/dev/null 2>&1 || true   # drop a rehearsal copy, if any
  gcloud sql databases create "$DB_NAME" --instance="$DB_INSTANCE" >/dev/null
fi

# PostgreSQL 18 tools (the same major version as Railway), installed here (Cloud Shell's Docker Hub pulls can stall).
PG=/usr/lib/postgresql/18/bin
[ -x "$PG/pg_dump" ] || sudo apt-get install -y -qq postgresql-client-18 >/dev/null
export PGPASSWORD="$(cat "$STATE/db-password")"

if [ "${FILES_ONLY:-0}" != 1 ]; then
echo "== 1/4 Copying the database out of Railway"
"$PG/pg_dump" --format=custom --no-owner --no-acl --dbname="$SRC_DB" --file="$STATE/db.dump"
ls -lh "$STATE/db.dump"

echo "== 2/4 Loading it into Cloud SQL"
if [ ! -x "$STATE/cloud-sql-proxy" ]; then
  curl -sSL -o "$STATE/cloud-sql-proxy" https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64
  chmod +x "$STATE/cloud-sql-proxy"
fi
CONN=$(gcloud sql instances describe "$DB_INSTANCE" --format='value(connectionName)')
"$STATE/cloud-sql-proxy" --port 6543 --token "$(gcloud auth print-access-token)" "$CONN" > "$STATE/proxy.log" 2>&1 &
PROXY=$!; trap 'kill $PROXY 2>/dev/null || true' EXIT; sleep 4
TABLES=$("$PG/psql" -h 127.0.0.1 -p 6543 -U "$DB_USER" -d "$DB_NAME" -tAc "select count(*) from information_schema.tables where table_schema='public'")
if [ "$TABLES" != "0" ]; then echo "Cloud SQL already has $TABLES tables. To start over: gcloud sql databases delete $DB_NAME --instance=$DB_INSTANCE && gcloud sql databases create $DB_NAME --instance=$DB_INSTANCE" >&2; exit 1; fi
"$PG/pg_restore" --no-owner --no-acl --no-comments --no-publications --no-subscriptions --no-security-labels --exit-on-error -h 127.0.0.1 -p 6543 -U "$DB_USER" -d "$DB_NAME" "$STATE/db.dump"
"$PG/psql" -h 127.0.0.1 -p 6543 -U "$DB_USER" -d "$DB_NAME" \
  -c 'select count(*) as organizations from "Tenants";' -c 'select count(*) as people from "Users";'

fi

echo "== 3/4 Uploaded files"
command -v rclone >/dev/null || sudo apt-get install -y -qq rclone >/dev/null
read -r HMAC_ID HMAC_SECRET < "$STATE/hmac"
export RCLONE_CONFIG_GCS_TYPE=s3 RCLONE_CONFIG_GCS_PROVIDER=GCS RCLONE_CONFIG_GCS_ENDPOINT=https://storage.googleapis.com \
  RCLONE_CONFIG_GCS_ACCESS_KEY_ID="$HMAC_ID" RCLONE_CONFIG_GCS_SECRET_ACCESS_KEY="$HMAC_SECRET"
API="$STATE/railway-api.env"
if [ "$(get Storage__Provider "$API")" = "S3" ]; then
  export RCLONE_CONFIG_RW_TYPE=s3 RCLONE_CONFIG_RW_PROVIDER=Other RCLONE_CONFIG_RW_ENDPOINT="$(get Storage__S3__ServiceUrl "$API")" \
    RCLONE_CONFIG_RW_ACCESS_KEY_ID="$(get Storage__S3__AccessKeyId "$API")" RCLONE_CONFIG_RW_SECRET_ACCESS_KEY="$(get Storage__S3__SecretAccessKey "$API")" \
    RCLONE_CONFIG_RW_REGION="$(get Storage__S3__Region "$API")" RCLONE_CONFIG_RW_FORCE_PATH_STYLE=true
  SRC_PREFIX=$(get Storage__S3__Prefix "$API")
  rclone copy --stats-one-line --stats 30s "rw:$(get Storage__S3__Bucket "$API")/${SRC_PREFIX}" "gcs:${BUCKET}/files"
else
  # Files on the Railway server's disk: packed there and unpacked into the bucket with the same names.
  railway ssh --service API -- tar czf - -C /app/data files > "$STATE/files.tgz" || { echo "Could not read files from Railway; if the API has no files yet this is fine."; : > "$STATE/files.tgz"; }
  if [ -s "$STATE/files.tgz" ]; then rm -rf "$STATE/files" && mkdir -p "$STATE/files" && tar xzf "$STATE/files.tgz" -C "$STATE/files" && \
    gcloud storage cp -r "$STATE/files/files/*" "gs://${BUCKET}/files/"; fi
fi

echo "== 4/4 Call recordings"
if [ -n "$(get Voice__S3Bucket "$API")" ]; then
  export RCLONE_CONFIG_RV_TYPE=s3 RCLONE_CONFIG_RV_PROVIDER=Other RCLONE_CONFIG_RV_ENDPOINT="$(get Voice__S3Endpoint "$API")" \
    RCLONE_CONFIG_RV_ACCESS_KEY_ID="$(get Voice__S3AccessKey "$API")" RCLONE_CONFIG_RV_SECRET_ACCESS_KEY="$(get Voice__S3SecretKey "$API")" \
    RCLONE_CONFIG_RV_REGION="$(get Voice__S3Region "$API")" RCLONE_CONFIG_RV_FORCE_PATH_STYLE=true
  rclone copy --stats-one-line --stats 30s "rv:$(get Voice__S3Bucket "$API")" "gcs:${BUCKET}" --exclude "files/**"
fi
echo "Moved. Next: ./5-start.sh"
