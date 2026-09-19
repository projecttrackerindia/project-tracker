#!/usr/bin/env sh
# Automated PostgreSQL backup for Project Tracker.
#
# Why this exists: the repository had no backup/restore automation at all
# (architecture review, OPS-03) — whatever backup story existed was entirely
# outside the repo (e.g. a hosting provider's managed-Postgres default), with
# no documented, tested restore path. This script + docs/BACKUP_RESTORE.md
# give you a portable, provider-agnostic backup you control directly.
#
# What it does: pg_dump's the database referenced by DATABASE_URL to a
# timestamped, gzip-compressed custom-format file, uploads it to S3 if S3
# credentials are configured (reusing this app's existing boto3/S3 setup —
# see scaling_runtime.py), and prunes local backups older than
# BACKUP_RETENTION_DAYS. Safe to run repeatedly; each run is independent.
#
# Usage:
#   sh scripts/backup_db.sh
#
# Scheduling on Railway: add this as a Cron Job service (railway.app ->
# New -> Cron Job) pointed at this repo, with a schedule like `0 3 * * *`
# (daily at 03:00 UTC) and start command `sh scripts/backup_db.sh`. Give
# that service the same DATABASE_URL (reference variable) as the web
# service, plus S3 credentials if you want off-instance storage — Railway's
# own filesystem is ephemeral, so a local-only backup does not survive a
# redeploy. See docs/BACKUP_RESTORE.md for full setup and restore steps.
set -eu

: "${BACKUP_DIR:=./backups}"
: "${BACKUP_RETENTION_DAYS:=14}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set. Nothing to back up." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/project-tracker-$STAMP.dump"

echo "Backing up database to $FILE ..."
# Custom format (-Fc): compressed, supports selective/parallel restore via
# pg_restore, and is the format Postgres itself recommends for anything
# beyond a toy database.
pg_dump "$DATABASE_URL" -Fc -f "$FILE"
echo "Backup complete: $(du -h "$FILE" | cut -f1)"

# Optional off-instance upload — reuses the same env vars scaling_runtime.py
# already reads for S3-backed file storage, so no new configuration concept
# is introduced. Skipped entirely (not an error) if they're not set.
if [ -n "${S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  echo "Uploading to s3://$S3_BUCKET/db-backups/$(basename "$FILE") ..."
  aws s3 cp "$FILE" "s3://$S3_BUCKET/db-backups/$(basename "$FILE")"
elif [ -n "${S3_BUCKET:-}" ]; then
  echo "S3_BUCKET is set but the aws CLI isn't installed — skipping upload. Install awscli or use Railway's own backup/volume features." >&2
fi

# Prune local backups older than the retention window so an ephemeral
# instance disk (or a long-lived one) doesn't fill up over time.
find "$BACKUP_DIR" -name 'project-tracker-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -print -delete 2>/dev/null || true

echo "Done."
