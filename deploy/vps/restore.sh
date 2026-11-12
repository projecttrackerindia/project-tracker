#!/usr/bin/env bash
# The restore drill, and the real restore. Same script, because a drill that differs from the real thing proves nothing.
#
#   ./restore.sh --drill                  restore the newest backup into a throwaway container and report row counts
#   ./restore.sh --drill db/daily/X.gpg   same, for a specific backup
#   ./restore.sh --into-production        restore into the live database. Asks twice. Destroys current data.
#
# Run the drill monthly. A backup you have never restored is a guess, and the morning you need it is the
# worst possible time to find out which guess it was.
set -euo pipefail

cd "$(dirname "$0")"
[ -f backup.env ] || { echo "backup.env is missing" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./backup.env; set +a
: "${S3_BUCKET:?}"; : "${S3_ENDPOINT:?}"; : "${PASSPHRASE_FILE:?}"
: "${DB_NAME:=projecttracker}"; : "${DB_USER:=pt}"; : "${COMPOSE_DIR:=/opt/pt}"

MODE="${1:---drill}"
OBJECT="${2:-}"
WORK="$(mktemp -d)"
DRILL_NAME="pt-restore-drill-$$"
cleanup() { rm -rf "$WORK"; docker rm -f "$DRILL_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

aws_s3() { aws --endpoint-url "$S3_ENDPOINT" s3 "$@"; }

if [ -z "$OBJECT" ]; then
  NEWEST="$(aws_s3 ls "s3://$S3_BUCKET/db/daily/" | awk '{print $4}' | sort -r | head -1)"
  [ -n "$NEWEST" ] || { echo "no backups found in s3://$S3_BUCKET/db/daily/" >&2; exit 1; }
  OBJECT="db/daily/$NEWEST"
fi

echo "restoring $OBJECT"
aws_s3 cp "s3://$S3_BUCKET/$OBJECT" "$WORK/dump.pgc.gpg" >/dev/null
gpg --batch --yes --quiet --decrypt --passphrase-file "$PASSPHRASE_FILE" \
    --output "$WORK/dump.pgc" "$WORK/dump.pgc.gpg"
echo "decrypted: $(stat -c%s "$WORK/dump.pgc") bytes"

case "$MODE" in
  --drill)
    # A clean container of the same PostgreSQL major version as production, thrown away at the end.
    PGVER="$(docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db postgres --version | grep -oE '[0-9]+' | head -1)"
    echo "starting throwaway postgres ${PGVER}"
    docker run -d --name "$DRILL_NAME" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB="$DB_NAME" \
      -e POSTGRES_USER="$DB_USER" "postgres:${PGVER}-alpine" >/dev/null
    for _ in $(seq 1 60); do
      docker exec "$DRILL_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
      sleep 1
    done
    docker exec -i "$DRILL_NAME" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges < "$WORK/dump.pgc" 2> "$WORK/err.txt" \
      || { echo "--- pg_restore output ---"; cat "$WORK/err.txt"; echo "RESTORE DRILL FAILED"; exit 1; }

    echo
    echo "=== restored, 15 largest tables ==="
    docker exec -i "$DRILL_NAME" psql -U "$DB_USER" -d "$DB_NAME" -At -F$'\t' -c "
      SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;" \
      | awk -F'\t' '{printf \"  %-42s %s\\n\", $1, $2}'
    TOTAL="$(docker exec -i "$DRILL_NAME" psql -U "$DB_USER" -d "$DB_NAME" -At -c \
      "SELECT coalesce(sum(n_live_tup),0) FROM pg_stat_user_tables;")"
    echo
    echo "total rows restored: $TOTAL"
    [ "${TOTAL:-0}" -gt 0 ] || { echo "RESTORE DRILL FAILED: the restore produced no rows"; exit 1; }
    echo "RESTORE DRILL PASSED"
    echo
    echo "Compare those counts against production. If they differ by more than a day's activity, investigate"
    echo "before trusting this backup."
    ;;

  --into-production)
    echo
    echo "This REPLACES the live database '$DB_NAME'. Everything currently in it is lost."
    echo "Backup to restore: $OBJECT"
    read -r -p "Type the database name to continue: " a; [ "$a" = "$DB_NAME" ] || { echo "aborted"; exit 1; }
    read -r -p "Type RESTORE to confirm: " b; [ "$b" = "RESTORE" ] || { echo "aborted"; exit 1; }

    # Take a dump of what is there first. If this restore turns out to be the wrong backup, that decision stays reversible.
    SAFETY="/var/backups/pt-before-restore-$(date -u +%Y%m%dT%H%M%SZ).pgc"
    mkdir -p /var/backups
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db \
      pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner --no-privileges > "$SAFETY" || true
    echo "current database saved to $SAFETY"

    docker compose -f "$COMPOSE_DIR/docker-compose.yml" stop api
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db \
      psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db \
      pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges < "$WORK/dump.pgc"
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" start api
    echo "restored. Check the site, then confirm row counts."
    ;;

  *) echo "usage: $0 [--drill|--into-production] [object]" >&2; exit 2 ;;
esac
