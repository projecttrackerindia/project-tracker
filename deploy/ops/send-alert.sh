#!/usr/bin/env bash
# Sends one ops alert by email and/or WhatsApp. Each channel is skipped quietly when its settings are empty.
#   send-alert.sh "<subject>" "<body>"
# Email (Resend HTTP API):  ALERT_RESEND_API_KEY (secret), ALERT_EMAIL_FROM, ALERT_EMAIL_TO (comma separated)
# WhatsApp (Meta Cloud API, the same Meta app / phone number as the Desk WhatsApp integration):
#   ALERT_WHATSAPP_TOKEN (secret), ALERT_WHATSAPP_PHONE_ID, ALERT_WHATSAPP_TO (comma separated, e.g. 9198xxxxxxxx),
#   ALERT_WHATSAPP_TEMPLATE (an approved utility template with ONE body variable, e.g. "ops_alert"), ALERT_WHATSAPP_LANG (default en)
set -uo pipefail
subject="$1"; body="$2"; sent=0
json() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
if [ -n "${ALERT_RESEND_API_KEY:-}" ] && [ -n "${ALERT_EMAIL_TO:-}" ]; then
  to=$(python3 -c 'import json,sys; print(json.dumps([e.strip() for e in sys.argv[1].split(",") if e.strip()]))' "$ALERT_EMAIL_TO")
  if curl -sf -m 20 https://api.resend.com/emails -H "Authorization: Bearer $ALERT_RESEND_API_KEY" -H 'Content-Type: application/json' \
       --data "{\"from\":$(json "${ALERT_EMAIL_FROM:-alerts@projecttracker.in}"),\"to\":$to,\"subject\":$(json "$subject"),\"text\":$(json "$body")}" >/dev/null
  then echo "email sent"; sent=1; else echo "::warning::alert email failed"; fi
fi
if [ -n "${ALERT_WHATSAPP_TOKEN:-}" ] && [ -n "${ALERT_WHATSAPP_PHONE_ID:-}" ] && [ -n "${ALERT_WHATSAPP_TO:-}" ]; then
  text="$subject: ${body:0:900}"; text="${text//$'\n'/ · }"
  IFS=',' read -ra nums <<<"$ALERT_WHATSAPP_TO"
  for n in "${nums[@]}"; do
    n="${n// /}"; [ -n "$n" ] || continue
    if curl -sf -m 20 "https://graph.facebook.com/v21.0/${ALERT_WHATSAPP_PHONE_ID}/messages" -H "Authorization: Bearer $ALERT_WHATSAPP_TOKEN" \
         -H 'Content-Type: application/json' --data "{\"messaging_product\":\"whatsapp\",\"to\":$(json "$n"),\"type\":\"template\",\"template\":{\"name\":$(json "${ALERT_WHATSAPP_TEMPLATE:-ops_alert}"),\"language\":{\"code\":$(json "${ALERT_WHATSAPP_LANG:-en}")},\"components\":[{\"type\":\"body\",\"parameters\":[{\"type\":\"text\",\"text\":$(json "$text")}]}]}}" >/dev/null
    then echo "whatsapp sent to ...${n: -4}"; sent=1; else echo "::warning::alert WhatsApp to ...${n: -4} failed"; fi
  done
fi
[ "$sent" = 1 ] || echo "::warning::No alert channel is configured (see docs/ops.md › Uptime)."
exit 0
