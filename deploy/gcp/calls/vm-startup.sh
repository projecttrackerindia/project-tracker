#!/bin/bash
# Runs on the calls server at every boot: Docker (for Caddy, which gets the HTTPS certificate), the LiveKit media server as a system service
# (from LiveKit's own release, checked against its known fingerprint), larger network buffers for many video streams, and a nightly check
# that picks up a renewed certificate. Nothing secret is in here: the keys arrive later in /opt/calls/calls.env (calls.sh copies them).
set -euo pipefail
LK_VERSION=1.11.0
LK_SHA256=3e76ed51ecdfefc3005e4257095dccd1ccc8f8b77517d9f2353de7906650b68b

if ! command -v docker >/dev/null; then
  apt-get update && apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

if [ "$(/usr/local/bin/livekit-server --version 2>/dev/null | awk '{print $NF}')" != "$LK_VERSION" ]; then
  curl -fsSL -o /tmp/livekit.tgz "https://github.com/livekit/livekit/releases/download/v${LK_VERSION}/livekit_${LK_VERSION}_linux_amd64.tar.gz"
  echo "${LK_SHA256}  /tmp/livekit.tgz" | sha256sum -c -
  tar -xzf /tmp/livekit.tgz -C /usr/local/bin livekit-server && chmod 755 /usr/local/bin/livekit-server && rm -f /tmp/livekit.tgz
fi

# Many video streams at once: room for them in the network buffers.
cat > /etc/sysctl.d/90-pt-calls.conf <<'SYS'
net.core.rmem_max=5000000
net.core.wmem_max=5000000
SYS
sysctl --system >/dev/null

cat > /etc/systemd/system/livekit.service <<'UNIT'
[Unit]
Description=LiveKit media server (ProjectTracker calls)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/calls/livekit.yaml

[Service]
ExecStart=/usr/local/bin/livekit-server --config /opt/calls/livekit.yaml
Restart=always
RestartSec=3
LimitNOFILE=500000

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/pt-calls-apply.service <<'UNIT'
[Unit]
Description=Rewrite the media server's settings (and pick up a renewed certificate)
ConditionPathExists=/opt/calls/apply.sh

[Service]
Type=oneshot
ExecStart=/opt/calls/apply.sh
UNIT
# 22:00 UTC is 03:30 in India: a certificate renewed during the day is picked up when nobody is in a call.
cat > /etc/systemd/system/pt-calls-apply.timer <<'UNIT'
[Unit]
Description=Nightly check of the media server's certificate

[Timer]
OnCalendar=*-*-* 22:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable livekit.service pt-calls-apply.timer >/dev/null 2>&1 || true
systemctl start pt-calls-apply.timer || true

mkdir -p /opt/calls
if [ -f /opt/calls/calls.env ] && [ -f /opt/calls/docker-compose.yml ]; then
  cd /opt/calls && docker compose up -d && /opt/calls/apply.sh
fi
