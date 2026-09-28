#!/bin/sh
# Nightly backup of the database and uploaded files. Runs inside the "backup" service (postgres:16-alpine).
#
#   db-YYYYMMDD-HHMMSS.dump    pg_dump custom format  (restore with pg_restore, see deploy/restore.sh)
#   files-YYYYMMDD-HHMMSS.tgz  the uploaded-files volume
#
# Settings (environment):
#   BACKUP_HOUR_UTC   hour of day (00-23, UTC) to back up            default 02
#   BACKUP_KEEP_DAYS  delete backups older than this many days       default 14
#   BACKUP_ON_START   take one at start-up if none is < 24 h old    default true
set -eu

DIR=/backups
HOUR="${BACKUP_HOUR_UTC:-02}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
export PGPASSWORD="${PGPASSWORD:?PGPASSWORD is required}"
DB_HOST="${DB_HOST:-db}"; DB_NAME="${DB_NAME:-projectmanagement}"; DB_USER="${DB_USER:-postgres}"

mkdir -p "$DIR"

backup_once() {
  ts=$(date -u +%Y%m%d-%H%M%S)
  echo "[$(date -u +%FT%TZ)] backup $ts: database"
  # Written under a dot-name first so a half-finished file is never mistaken for a good backup.
  pg_dump -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -Fc -f "$DIR/.db-$ts.part"
  mv "$DIR/.db-$ts.part" "$DIR/db-$ts.dump"

  if [ -d /files ] && [ -n "$(ls -A /files 2>/dev/null)" ]; then
    echo "[$(date -u +%FT%TZ)] backup $ts: uploaded files"
    tar czf "$DIR/.files-$ts.part" -C /files .
    mv "$DIR/.files-$ts.part" "$DIR/files-$ts.tgz"
  fi

  find "$DIR" -maxdepth 1 -name 'db-*.dump' -mtime +"$KEEP" -delete
  find "$DIR" -maxdepth 1 -name 'files-*.tgz' -mtime +"$KEEP" -delete
  echo "$ts" > "$DIR/LAST_OK"
  echo "[$(date -u +%FT%TZ)] backup $ts: done ($(ls "$DIR"/db-*.dump | wc -l) database backups kept)"
}

# "backup.sh now" takes one backup immediately and exits (used before upgrades).
if [ "${1:-}" = "now" ]; then
  until pg_isready -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do sleep 3; done
  backup_once
  exit 0
fi

# Wait for the database, then catch up if the last backup is old (a fresh install or a long outage).
until pg_isready -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do sleep 3; done
if [ "${BACKUP_ON_START:-true}" = "true" ] && [ -z "$(find "$DIR" -maxdepth 1 -name 'db-*.dump' -mmin -1440 2>/dev/null)" ]; then
  backup_once || echo "[$(date -u +%FT%TZ)] start-up backup failed"
fi

last_day=""
while true; do
  today=$(date -u +%Y%m%d)
  if [ "$(date -u +%H)" = "$HOUR" ] && [ "$today" != "$last_day" ]; then
    if backup_once; then last_day="$today"; else echo "[$(date -u +%FT%TZ)] backup failed, will retry in a minute"; fi
  fi
  sleep 60
done
