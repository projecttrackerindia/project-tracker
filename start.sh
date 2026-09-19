#!/usr/bin/env sh
set -eu

# Railway injects PORT automatically. If PORT is missing or accidentally set to
# '$PORT' / '${PORT}', fall back to 8080 so the container still starts.
RAW_PORT="${PORT:-}"
case "$RAW_PORT" in
  ''|'$PORT'|'${PORT}') APP_PORT=8080 ;;
  *[!0-9]* ) APP_PORT=8080 ;;
  * ) APP_PORT="$RAW_PORT" ;;
esac

: "${WEB_CONCURRENCY:=2}"
: "${WEB_TIMEOUT:=75}"
: "${WEB_KEEPALIVE:=5}"
: "${MAX_REQUESTS:=1000}"
: "${MAX_REQUESTS_JITTER:=100}"
: "${PG_POOL_SIZE:=40}"
export PG_POOL_SIZE
# Run schema migrations on every deploy by default (previously required an
# operator to remember to set this manually — see app.py's advisory-lock
# guards on _run_startup_migrations_once()/_boot_v5_migrations() just above
# where those run, which make this safe even with WEB_CONCURRENCY>1: only one
# worker per deploy actually executes the DDL, the rest see the lock held and
# skip immediately. Set RUN_STARTUP_MIGRATIONS=0 explicitly to opt out of a
# specific deploy (e.g. a pure hotfix where you want to control migration
# timing separately via `python migrate.py`).
: "${RUN_STARTUP_MIGRATIONS:=1}"
export RUN_STARTUP_MIGRATIONS
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1
# Remove committed bytecode so Railway cannot run stale app.cpython-*.pyc.
find . -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true

echo "PORT env value: ${RAW_PORT:-<empty>}"
echo "Starting app on 0.0.0.0:${APP_PORT}"

exec gunicorn app:app \
  --bind "0.0.0.0:${APP_PORT}" \
  --worker-class gevent \
  --workers "${WEB_CONCURRENCY}" \
  --worker-connections "${WEB_WORKER_CONNECTIONS:-1000}" \
  --timeout "${WEB_TIMEOUT}" \
  --keep-alive "${WEB_KEEPALIVE}" \
  --graceful-timeout 10 \
  --max-requests "${MAX_REQUESTS}" \
  --max-requests-jitter "${MAX_REQUESTS_JITTER}" \
  --access-logfile - \
  --error-logfile -
