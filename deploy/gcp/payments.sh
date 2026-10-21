#!/usr/bin/env bash
# Switches how the live site takes payment, without printing any key.
#   ./payments.sh razorpay   take payments through Razorpay (keys from Secret Manager: razorpay-key-id, razorpay-key-secret,
#                            and optionally razorpay-webhook-secret)
#   ./payments.sh upi        back to UPI QR, confirmed by a platform administrator (the previous way)
#   ./payments.sh status     shows which one is on, and whether the key is a test or live key
# Only the API restarts (a few seconds). Settings live in /opt/pt/api.env on the server.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
MODE="${1:-status}"
secret() { gcloud secrets versions access latest --secret="$1" 2>/dev/null || true; }
remote() { gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="$1"; }
STRIP='sudo sed -i "/^Billing__Provider=/d;/^Billing__Razorpay__/d" /opt/pt/api.env'
# UPI QR, when switched on, wins over any provider; Razorpay mode turns it off and UPI mode turns it back on (the UPI accounts stay as they are).
UPI_OFF='sudo sed -i "/^Billing__Upi__Enabled=/d" /opt/pt/api.env && echo Billing__Upi__Enabled=false | sudo tee -a /opt/pt/api.env >/dev/null'
UPI_ON='sudo sed -i "/^Billing__Upi__Enabled=/d" /opt/pt/api.env && echo Billing__Upi__Enabled=true | sudo tee -a /opt/pt/api.env >/dev/null'
case "$MODE" in
  razorpay)
    ID=$(secret razorpay-key-id); KEY=$(secret razorpay-key-secret); HOOK=$(secret razorpay-webhook-secret)
    [ -n "$ID" ] && [ -n "$KEY" ] || { echo "Add the secrets razorpay-key-id and razorpay-key-secret in Secret Manager first." >&2; exit 1; }
    case "$ID" in rzp_test_*) echo "Key: TEST mode (no real money moves).";; rzp_live_*) echo "Key: LIVE mode.";; *) echo "That key id does not look like a Razorpay key." >&2; exit 1;; esac
    # The values travel over ssh's standard input, so they never appear in a command line or a log.
    { echo "Billing__Provider=Razorpay"; echo "Billing__Razorpay__KeyId=$ID"; echo "Billing__Razorpay__KeySecret=$KEY"
      [ -n "$HOOK" ] && echo "Billing__Razorpay__WebhookSecret=$HOOK"; } |
      gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="$STRIP && $UPI_OFF && sudo tee -a /opt/pt/api.env >/dev/null && cd /opt/pt && sudo docker compose up -d api >/dev/null && echo 'API restarted with Razorpay.'"
    [ -n "$HOOK" ] || echo "No webhook secret yet: payments still confirm from the browser; add razorpay-webhook-secret and run this again for the backup."
    ;;
  upi)
    remote "$STRIP && $UPI_ON && cd /opt/pt && sudo docker compose up -d api >/dev/null && echo 'API restarted with UPI QR payments.'"
    ;;
  status)
    remote 'p=$(sudo grep -h "^Billing__Provider=" /opt/pt/api.env | cut -d= -f2); k=$(sudo grep -h "^Billing__Razorpay__KeyId=" /opt/pt/api.env | cut -d= -f2 | cut -c1-9); h=$(sudo grep -c "^Billing__Razorpay__WebhookSecret=" /opt/pt/api.env || true); u=$(sudo grep -h "^Billing__Upi__Enabled=" /opt/pt/api.env | tail -1 | cut -d= -f2); echo "UPI QR: ${u:-?}  Provider: ${p:-Mock}  key: ${k:-none}  webhook secret: $([ "${h:-0}" -gt 0 ] && echo set || echo not set)"'
    ;;
  *) echo "Usage: ./payments.sh razorpay|upi|status" >&2; exit 1;;
esac
