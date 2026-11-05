#!/usr/bin/env bash
# Checks vm-release.sh without a server: a stand-in `docker` records what it is asked and fails health for $BAD_TAG.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/bin" "$t/pt"
cat > "$t/bin/docker" <<'D'
#!/usr/bin/env bash
tag=$(grep -m1 '^TAG=' .env | cut -d= -f2-)
echo "docker $* [TAG=$tag]" >> "$LOG"
case "$*" in
  "compose ps -q api") echo cid ;;
  "inspect --format {{.Image}} cid") echo sha256:img ;;
  "image inspect sha256:img"*) printf 'r/p/api:latest\nr/p/api:%s\n' "${RUNNING:-aaa1111}" ;;
  "compose config --services") printf 'web\napi\n' ;;
  "compose exec -T web wget"*) [ "$tag" != "${BAD_TAG:-}" ] ;;
  *) true ;;
esac
D
chmod +x "$t/bin/docker"
export PATH="$t/bin:$PATH" PT_DIR="$t/pt" LOG="$t/log" HEALTH_TRIES=1
run() { bash "$here/vm-release.sh" "$@"; }
fail() { echo "FAIL: $*" >&2; cat "$LOG" >&2; exit 1; }

echo "TAG=latest" > "$t/pt/.env"
[ "$(run --current)" = aaa1111 ] || fail "resolves latest to the running tag"
run bbb2222 >/dev/null
grep -qx 'TAG=bbb2222' "$t/pt/.env" || fail "pins the new tag"
[ "$(run --previous)" = aaa1111 ] || fail "remembers the previous tag"

BAD_TAG=ccc3333 run ccc3333 >/dev/null 2>&1 && fail "a failing release exits non-zero"
grep -qx 'TAG=bbb2222' "$t/pt/.env" || fail "a failing release goes back to the previous tag"
[ "$(cat "$t/pt/.release")" = bbb2222 ] || fail "live release stays bbb2222"

: > "$LOG"; BAD_TAG=ddd4444 NO_ROLLBACK=1 run ddd4444 >/dev/null 2>&1 && fail "NO_ROLLBACK still fails"
grep -qx 'TAG=ddd4444' "$t/pt/.env" || fail "NO_ROLLBACK leaves the tag"
run 'bad;tag' >/dev/null 2>&1 && fail "rejects odd tags"
grep -q 'up -d meetbot' "$LOG" && fail "does not start a meeting bot that is not configured"
echo "vm-release.sh: all checks passed"
