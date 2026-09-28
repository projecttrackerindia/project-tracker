#!/bin/sh
# Restore a backup made by the backup service.  Run from the folder that holds docker-compose.yml.
#
#   sh deploy/restore.sh db-20260101-020000.dump [files-20260101-020000.tgz]
#
# What it does: stops the API, replaces the database with the backup (and the uploaded files, if given), starts the API again.
# The current database is renamed to <name>_before_restore first, so a wrong choice can be undone.
#
# To only CHECK that a backup is readable without touching anything, restore into a scratch database:
#   sh deploy/restore.sh db-20260101-020000.dump --verify-only
set -eu

DB_FILE="${1:?usage: restore.sh <db-file> [files-file | --verify-only]}"
EXTRA="${2:-}"
COMPOSE="${COMPOSE:-docker compose}"
DB_NAME="${DB_NAME:-projectmanagement}"
FILE_IN_VOLUME="/backups/$DB_FILE"

$COMPOSE exec -T backup test -f "$FILE_IN_VOLUME" </dev/null || { echo "No such backup in the backups volume: $DB_FILE"; exit 1; }

if [ "$EXTRA" = "--verify-only" ]; then
  echo "Restoring $DB_FILE into a scratch database to check it ..."
  $COMPOSE exec -T backup sh -c "dropdb -h db -U postgres --if-exists restore_check && createdb -h db -U postgres restore_check && pg_restore -h db -U postgres -d restore_check --no-owner '$FILE_IN_VOLUME' && psql -h db -U postgres -d restore_check -tAc \"select 'users: ' || count(*) from \\\"Users\\\"\" ; dropdb -h db -U postgres restore_check" </dev/null
  echo "The backup is readable."
  exit 0
fi

printf 'This replaces the live database with %s. Type RESTORE to continue: ' "$DB_FILE"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

$COMPOSE stop api web </dev/null
stamp=$(date -u +%Y%m%d%H%M%S)
$COMPOSE exec -T backup sh -c "psql -h db -U postgres -d postgres -c \"select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB_NAME' and pid <> pg_backend_pid()\" >/dev/null && psql -h db -U postgres -d postgres -c \"alter database $DB_NAME rename to ${DB_NAME}_before_restore_$stamp\" && createdb -h db -U postgres $DB_NAME && pg_restore -h db -U postgres -d $DB_NAME --no-owner '$FILE_IN_VOLUME'" </dev/null

if [ -n "$EXTRA" ]; then
  echo "Restoring uploaded files from $EXTRA ..."
  # The API image has the files volume mounted writable (and the backups volume read-only), so it does this step.
  $COMPOSE run --rm --no-deps -T --entrypoint sh api -c "test -f '/backups/$EXTRA' && find /app/data/files -mindepth 1 -delete && tar xzf '/backups/$EXTRA' -C /app/data/files" </dev/null
fi

$COMPOSE start api web </dev/null
echo "Done. The previous database is kept as ${DB_NAME}_before_restore_$stamp (drop it when you are sure)."
