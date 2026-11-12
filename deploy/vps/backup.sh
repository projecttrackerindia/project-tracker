#!/usr/bin/env bash
# Nightly (and intra-day) database backup: dump, encrypt, upload off this machine, prune, and say so.
#
# Nothing takes backups for us on a VPS. This script is the whole safety net, so it is written to fail loudly:
# a backup that silently stopped working six months ago is the most common way a company loses its data.
#
#   ./backup.sh            take a backup now
#   ./backup.sh --prune    prune old backups only
#
# Needs: docker compose running the "db" service, gpg, and the aws CLI (works with Cloudflare R2 and Backblaze B2).
# Configure in backup.env beside this script; see README.md.
set -euo pipefail

cd "$(dirname "$0")"
[ -f backup.env ] || { echo "backup.env is missing - copy backup.env.example and fill it in" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./backup.env; set +a

: "${S3_BUCKET:?set S3_BUCKET in backup.env}"
: "${S3_ENDPOINT:?set S3_ENDPOINT in backup.env}"
: "${PASSPHRASE_FILE:?set PASSPHRASE_FILE in backup.env}"
: "${DB_NAME:=projecttracker}"
: "${DB_USER:=pt}"
: "${COMPOSE_DIR:=/opt/pt}"
: "${KEEP_DAILY:=7}"
: "${KEEP_WEEKLY:=4}"
: "${KEEP_MONTHLY:=3}"
: "${MIN_BYTES:=100000}"          # a dump smaller than this is treated as a failure, not a small database

[ -r "$PASSPHRASE_FILE" ] || { echo "cannot read PASSPHRASE_FILE at $PASSPHRASE_FILE" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Anything that goes wrong after this point is reported, not swallowed. An unreported failure is the same as no backup.
fail() {
  local msg="$1"
  echo "BACKUP FAILED: $msg" >&2
  if [ -n "${ALERT_WEBHOOK:-}" ]; then
    curl -fsS -m 20 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"ProjectTracker backup FAILED on $(hostname): ${msg}\"}" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
  exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

aws_s3() { aws --endpoint-url "$S3_ENDPOINT" s3 "$@"; }

prune() {
  # Keep the most recent KEEP_DAILY daily, KEEP_WEEKLY weekly and KEEP_MONTHLY monthly objects. Listing is cheap;
  # deleting the wrong thing is not, so each class is pruned separately and only ever from its own prefix.
  local class keep
  for class in daily:"$KEEP_DAILY" weekly:"$KEEP_WEEKLY" monthly:"$KEEP_MONTHLY"; do
    keep="${class#*:}"; class="${class%%:*}"
    mapfile -t old < <(aws_s3 ls "s3://$S3_BUCKET/db/$class/" | awk '{print $4}' | sort -r | tail -n +"$((keep + 1))")
    for obj in "${old[@]:-}"; do
      [ -n "$obj" ] || continue
      aws_s3 rm "s3://$S3_BUCKET/db/$class/$obj" >/dev/null
      echo "pruned $class/$obj"
    done
  done
}

if [ "${1:-}" = "--prune" ]; then prune; echo "prune complete"; exit 0; fi

echo "[$STAMP] dumping $DB_NAME"
# -Fc is PostgreSQL's custom format: compressed, and restorable table by table. Dumping through the running
# container means no postgres client is needed on the host and the version always matches the server.
docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner --no-privileges > "$WORK/dump.pgc" \
  || fail "pg_dump returned non-zero"

SIZE="$(stat -c%s "$WORK/dump.pgc")"
[ "$SIZE" -ge "$MIN_BYTES" ] || fail "dump is only ${SIZE} bytes (minimum ${MIN_BYTES}) - the database may be empty or the dump truncated"

# A restore nobody can read is not a backup, so prove the dump parses before it is trusted and uploaded.
docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db pg_restore --list /dev/stdin < "$WORK/dump.pgc" > "$WORK/toc.txt" \
  || fail "pg_restore could not read the dump - it is corrupt"
TABLES="$(grep -c 'TABLE DATA' "$WORK/toc.txt" || true)"
[ "${TABLES:-0}" -ge 1 ] || fail "the dump contains no table data"

echo "dump ok: ${SIZE} bytes, ${TABLES} tables"

# Customer data is about to leave this machine, so it is encrypted first. Symmetric AES-256 with a passphrase
# kept only on this server and in your password manager - if both are lost the backups are unreadable, by design.
gpg --batch --yes --symmetric --cipher-algo AES256 --compress-algo none \
    --passphrase-file "$PASSPHRASE_FILE" --output "$WORK/dump.pgc.gpg" "$WORK/dump.pgc" \
  || fail "encryption failed"

DOW="$(date -u +%u)"; DOM="$(date -u +%d)"
CLASSES=("daily")
[ "$DOW" = "7" ] && CLASSES+=("weekly")
[ "$DOM" = "01" ] && CLASSES+=("monthly")

for class in "${CLASSES[@]}"; do
  aws_s3 cp "$WORK/dump.pgc.gpg" "s3://$S3_BUCKET/db/$class/${STAMP}.pgc.gpg" >/dev/null \
    || fail "upload to $class failed"
  echo "uploaded db/$class/${STAMP}.pgc.gpg"
done

prune

if [ -n "${ALERT_WEBHOOK:-}" ] && [ "${NOTIFY_ON_SUCCESS:-0}" = "1" ]; then
  curl -fsS -m 20 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"ProjectTracker backup ok: ${SIZE} bytes, ${TABLES} tables, ${STAMP}\"}" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
fi

echo "backup complete"
