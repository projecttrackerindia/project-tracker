#!/bin/sh
# Writes the media server's settings from /opt/calls/calls.env and restarts it only when something changed: the settings themselves,
# or the HTTPS certificate Caddy renewed (used for TURN over TLS, the way in from networks that allow nothing but HTTPS-like traffic).
set -eu
cd /opt/calls
. ./calls.env
HOST="calls.${DOMAIN}"
CERTS="/opt/calls/caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${HOST}"
TLS=""
if [ -s "${CERTS}/${HOST}.crt" ] && [ -s "${CERTS}/${HOST}.key" ]; then
  TLS="  tls_port: 5349
  cert_file: ${CERTS}/${HOST}.crt
  key_file: ${CERTS}/${HOST}.key"
fi
umask 077
cat > livekit.yaml.new <<YAML
# Written by apply.sh from calls.env - edit calls.env (or run deploy/gcp/calls.sh again), not this file.
port: 7880
bind_addresses: ["127.0.0.1"]   # the control port is reached only through Caddy (HTTPS); media ports are open below
log_level: info
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
room:
  max_participants: ${MAX_PARTICIPANTS:-50}
  empty_timeout: 300
  departure_timeout: 60
keys:
  ${LK_KEY}: ${LK_SECRET}
webhook:
  api_key: ${LK_KEY}
  urls:
    - https://${DOMAIN}/api/v1/calls/livekit
turn:
  enabled: true
  domain: ${HOST}
  udp_port: 3478
  relay_range_start: 30000
  relay_range_end: 40000
${TLS}
YAML
STAMP=$( (cat livekit.yaml.new; [ -n "$TLS" ] && cat "${CERTS}/${HOST}.crt") | sha256sum | cut -d' ' -f1)
if [ "$STAMP" != "$(cat .applied 2>/dev/null || true)" ] || ! systemctl is-active --quiet livekit; then
  mv livekit.yaml.new livekit.yaml
  systemctl restart livekit
  echo "$STAMP" > .applied
  echo "media server (re)started$( [ -n "$TLS" ] && echo ' with TURN over TLS' || echo ' (TURN over TLS waits for the certificate)')"
else
  rm -f livekit.yaml.new
  echo "media server unchanged"
fi
