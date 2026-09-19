# Backup & Restore

This document exists because the repository previously had **no backup or
restore automation at all** (architecture review, finding OPS-03) — whatever
backup story existed was entirely outside the repo, undocumented, and
untested. This is the fix: a script you control directly, and a restore
procedure you can actually run before you need it for real.

## How backups work

`scripts/backup_db.sh` runs `pg_dump` against `DATABASE_URL` in Postgres's
custom format (`-Fc`), which is compressed and restorable selectively via
`pg_restore`. If `S3_BUCKET` (and AWS credentials, and the `aws` CLI) are
configured, it also uploads the dump to S3 — the same env vars
`scaling_runtime.py` already uses for file storage, so there's nothing new to
configure if you're already using that. Local backups older than
`BACKUP_RETENTION_DAYS` (default 14) are pruned automatically.

## Scheduling it

**Railway (recommended for this deployment):**

1. In your Railway project, **New → Cron Job**, pointed at this same repo.
2. Start command: `sh scripts/backup_db.sh`
3. Schedule: e.g. `0 3 * * *` for daily at 03:00 UTC.
4. Variables: reference the same `DATABASE_URL` your web service uses (Railway
   → Variables → "Add Reference"), plus `S3_BUCKET`/`S3_ACCESS_KEY_ID`/
   `S3_SECRET_ACCESS_KEY` if you want off-instance storage. **This step
   matters** — Railway's own filesystem is ephemeral, so a backup written
   only to local disk does not survive a redeploy or restart.

**Anywhere else (Docker Compose / a VM with real cron):**

```cron
0 3 * * * cd /path/to/project-tracker && DATABASE_URL=... sh scripts/backup_db.sh >> /var/log/pt-backup.log 2>&1
```

## Restoring

**Test this now, before you need it for real** — a backup you've never
restored is a backup you don't actually have.

1. Get the dump file (from local `./backups/`, or `aws s3 cp
   s3://$S3_BUCKET/db-backups/<file>.dump .`).
2. Restore into a **new, empty database first** — never restore directly
   over production without a verified dry run:
   ```sh
   createdb project_tracker_restore_test
   pg_restore -d project_tracker_restore_test --no-owner --no-privileges project-tracker-<timestamp>.dump
   ```
3. Sanity-check it: connect and confirm row counts on a few key tables look
   right (`workspaces`, `users`, `tasks`).
4. Only once you've verified step 3, restore over the real target:
   ```sh
   pg_restore -d "$DATABASE_URL" --no-owner --no-privileges --clean --if-exists project-tracker-<timestamp>.dump
   ```
   `--clean --if-exists` drops existing objects before recreating them, so
   this is a **full replace** — take a fresh backup of the current state
   first if there's any chance you'll want to go back.
5. Restart the app (or the affected Railway service) so cached connections
   don't retain a stale view of the schema.

## What this does not cover

- **Point-in-time recovery** (restoring to an arbitrary moment, not just the
  last nightly dump) — for that, use your Postgres provider's native
  continuous-backup/WAL-archiving feature if it offers one (Railway's managed
  Postgres and most managed providers do); this script is a portable
  supplement to that, not a replacement for it.
- **Application-level file storage** (uploaded files under `pf_uploads/` or
  S3) — back those up separately if you're not already using S3 for uploads
  in production (local-disk uploads on Railway are as ephemeral as anything
  else there).
