#!/usr/bin/env bash
# Chooses how the live site sends e-mail, without printing any password.
#   ./mail.sh gmail    send through Google Workspace (smtp.gmail.com:587) as support@projecttracker.in. Needs the secret
#                      gmail-app-password in Secret Manager: a 16-character app password made at myaccount.google.com/apppasswords
#                      while signed in as that mailbox (two-step verification must be on).
#   ./mail.sh resend   back to Resend (the settings that were in place before).
#   ./mail.sh status   shows which one is on.
# Only the API restarts (a few seconds). Settings live in /opt/pt/api.env on the server.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
MODE="${1:-status}"
SENDER="${MAIL_FROM:-support@projecttracker.in}"
remote() { gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="$1"; }
STRIP='sudo sed -i "/^Email__Provider=/d;/^Email__Smtp__/d" /opt/pt/api.env'
case "$MODE" in
  gmail)
    PASS=$(gcloud secrets versions access latest --secret=gmail-app-password 2>/dev/null | tr -d ' \n' || true)
    [ ${#PASS} -eq 16 ] || { echo "Add the secret gmail-app-password (the 16-character app password, spaces are fine) in Secret Manager first." >&2; exit 1; }
    # The password travels over ssh's standard input, so it never appears in a command line or a log.
    { echo "Email__Provider=Smtp"; echo "Email__Smtp__Host=smtp.gmail.com"; echo "Email__Smtp__Port=587"; echo "Email__Smtp__EnableSsl=true"
      echo "Email__Smtp__Username=$SENDER"; echo "Email__Smtp__Password=$PASS"; echo "Email__Smtp__From=$SENDER"; } |
      gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="$STRIP && sudo tee -a /opt/pt/api.env >/dev/null && cd /opt/pt && sudo docker compose up -d api >/dev/null && echo 'API restarted: e-mail now goes through Gmail as $SENDER.'"
    ;;
  resend)
    remote "$STRIP && echo Email__Provider=Resend | sudo tee -a /opt/pt/api.env >/dev/null && cd /opt/pt && sudo docker compose up -d api >/dev/null && echo 'API restarted: e-mail goes through Resend.'"
    ;;
  status)
    remote 'p=$(sudo grep -h "^Email__Provider=" /opt/pt/api.env | tail -1 | cut -d= -f2); h=$(sudo grep -h "^Email__Smtp__Host=" /opt/pt/api.env | tail -1 | cut -d= -f2); f=$(sudo grep -h "^Email__Smtp__From=\|^Email__Resend__From=" /opt/pt/api.env | tail -1 | cut -d= -f2-); echo "E-mail: ${p:-Log (not sending)} ${h:+via $h} from ${f:-?}"'
    ;;
  *) echo "Usage: ./mail.sh gmail|resend|status" >&2; exit 1;;
esac
