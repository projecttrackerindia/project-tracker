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
: "${PG_POOL_SIZE:=12}"
export PG_POOL_SIZE
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
