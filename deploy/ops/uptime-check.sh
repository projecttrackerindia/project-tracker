#!/usr/bin/env bash
# Checks the site's key flows once. Prints one line per check; exits 1 if any failed (the failures are in $FAILED_FILE if set).
#   BASE_URL (default https://projecttracker.in)
#   UPTIME_LOGIN_EMAIL / UPTIME_LOGIN_PASSWORD  optional: also signs in as a dedicated monitoring account (fictional, no data)
set -uo pipefail
BASE="${BASE_URL:-https://projecttracker.in}"; BASE="${BASE%/}"
CURL="${CURL:-curl}"
fails=()
check() { # name path expected-status must-contain
  local name="$1" path="$2" want="$3" needle="${4:-}" out code body
  out=$($CURL -s -m 15 -o - -w $'\n%{http_code}' "$BASE$path" 2>/dev/null) || true
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$code" = "$want" ] && { [ -z "$needle" ] || grep -q -- "$needle" <<<"$body"; }; then echo "ok    $name ($code)"
  else echo "FAIL  $name: got ${code:-no answer}, wanted $want${needle:+ with \"$needle\"}"; fails+=("$name"); fi
}
check "API ready (database reachable)" /health/ready 200 Healthy
check "Website loads" / 200 '<div id="root"'
check "API answers through the website" /api/v1/platform/status 200
check "Sign-in service" /api/v1/auth/password-policy 200
if [ -n "${UPTIME_LOGIN_EMAIL:-}" ] && [ -n "${UPTIME_LOGIN_PASSWORD:-}" ]; then
  code=$($CURL -s -m 15 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    --data "$(printf '{"email":"%s","password":"%s"}' "$UPTIME_LOGIN_EMAIL" "$UPTIME_LOGIN_PASSWORD")" "$BASE/api/v1/auth/login" 2>/dev/null || true)
  if [ "$code" = 200 ]; then echo "ok    Sign in (200)"; else echo "FAIL  Sign in: got ${code:-no answer}"; fails+=("Sign in"); fi
fi
[ -n "${FAILED_FILE:-}" ] && printf '%s\n' "${fails[@]:-}" | sed '/^$/d' > "$FAILED_FILE"
[ ${#fails[@]} -eq 0 ]
