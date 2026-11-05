#!/usr/bin/env bash
# Runs uptime-check.sh against a tiny local stand-in of the site: once healthy, once with the API down.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; t=$(mktemp -d); trap 'kill $srv 2>/dev/null || true; rm -rf "$t"' EXIT
cat > "$t/srv.py" <<'P'
import http.server, os, sys
DOWN = os.path.exists(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        down = os.path.exists(sys.argv[2])
        if self.path == "/": code, body = 200, b'<html><div id="root"></div></html>'
        elif self.path == "/health/ready": code, body = (503, b"Unhealthy") if down else (200, b"Healthy")
        elif self.path.startswith("/api/"): code, body = (502, b"") if down else (200, b"{}")
        else: code, body = 404, b""
        self.send_response(code); self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
P
port=$((20000 + RANDOM % 20000)); python3 -I "$t/srv.py" "$port" "$t/down" & srv=$!
# Wait for the stand-in to listen (a fixed sleep raced on a busy runner).
for _ in $(seq 1 50); do curl -s -o /dev/null --noproxy 127.0.0.1 "http://127.0.0.1:$port/" && break; sleep 0.2; done
export BASE_URL="http://127.0.0.1:$port" FAILED_FILE="$t/failed" NO_PROXY=127.0.0.1 no_proxy=127.0.0.1
bash "$here/uptime-check.sh" >/dev/null || { echo "FAIL: healthy site reported down"; exit 1; }
[ ! -s "$t/failed" ] || { echo "FAIL: failures listed for a healthy site"; exit 1; }
touch "$t/down"
if bash "$here/uptime-check.sh" >/dev/null; then echo "FAIL: down site reported healthy"; exit 1; fi
grep -q "API ready" "$t/failed" && ! grep -q "Website loads" "$t/failed" || { echo "FAIL: wrong failures: $(cat "$t/failed")"; exit 1; }
echo "uptime-check.sh: all checks passed"
