#!/usr/bin/env bash
# Step 3 (once): turns the Railway settings into the server's settings, pointing the database, files and recordings at Google Cloud.
#
# First export the current settings with the Railway CLI, in this Cloud Shell (they never leave your account):
#   npm i -g @railway/cli && railway login --browserless && railway link
#   railway variables --service API --kv > ~/.pt-gcp/railway-api.env
#   railway variables --service MeetBot --kv > ~/.pt-gcp/railway-meetbot.env     # skip if you do not use the meeting bot
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
[ -s "$STATE/railway-api.env" ] || { echo "Missing $STATE/railway-api.env - see the comment at the top of this script." >&2; exit 1; }
read -r HMAC_ID HMAC_SECRET < "$STATE/hmac"
DB_PASSWORD=$(cat "$STATE/db-password")
CONN=$(gcloud sql instances describe "$DB_INSTANCE" --format='value(connectionName)')
get() { grep -m1 "^$1=" "$2" 2>/dev/null | cut -d= -f2- || true; }
MEETBOT_SECRET=$(get Agent__MeetingBotSecret "$STATE/railway-api.env"); [ -n "$MEETBOT_SECRET" ] || MEETBOT_SECRET=$(get MEETBOT_SECRET "$STATE/railway-meetbot.env")
[ -n "$MEETBOT_SECRET" ] || MEETBOT_SECRET=$(openssl rand -hex 24)

# A value written over several lines cannot go into a Docker settings file: name it so it can be put on one line.
MULTI=$(awk '/^[A-Za-z_][A-Za-z0-9_]*=/{k=$0; sub(/=.*/,"",k); next} NF{print k}' "$STATE/railway-api.env" | sort -u)
if [ -n "$MULTI" ]; then echo "These settings span several lines and must be put on one line (for JSON, minify it) before continuing: $MULTI" >&2; exit 1; fi

# Everything from Railway except its own variables and what moves to Google Cloud.
OUT="$STATE/api.env"
grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$STATE/railway-api.env" \
  | grep -vE '^(RAILWAY_|PORT=|DATABASE_URL|DATABASE_PUBLIC_URL|PG[A-Z]*=|ConnectionStrings__|Database__Provider=|Storage__|Voice__S3|App__WebBaseUrl=|Cors__Origins__|Proxy__Trust=|Agent__MeetingBotUrl=|Agent__MeetingBotSecret=|Backups__|Redis__|Ai__PrimaryProvider=|Ai__Gemini__)' \
  | grep -v 'railway\.internal' > "$OUT" || true
# Anything else that still points at Railway is listed so it can be changed (nothing on the new server may depend on Railway).
LEFT=$(grep -E 'railway\.(app|internal)' "$STATE/railway-api.env" | cut -d= -f1 | tr '\n' ' ' || true)
[ -z "$LEFT" ] || echo "Left out (they pointed at Railway): $LEFT"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"   # served by Vertex AI in Mumbai; check with ./ai-check.sh
cat >> "$OUT" <<ENV
Database__Provider=Postgres
ConnectionStrings__Default=Host=cloudsql;Port=5432;Database=${DB_NAME};Username=${DB_USER};Password=${DB_PASSWORD};SSL Mode=Disable;Maximum Pool Size=40
App__WebBaseUrl=https://${DOMAIN}
Cors__Origins__0=https://${DOMAIN}
Proxy__Trust=true
Storage__Provider=S3
Storage__S3__Bucket=${BUCKET}
Storage__S3__ServiceUrl=https://storage.googleapis.com
Storage__S3__Region=auto
Storage__S3__ForcePathStyle=true
Storage__S3__Prefix=files
Storage__S3__AccessKeyId=${HMAC_ID}
Storage__S3__SecretAccessKey=${HMAC_SECRET}
Storage__MigrateLocal=true
Storage__LocalPath=/app/data/files
Voice__S3Endpoint=https://storage.googleapis.com
Voice__S3Bucket=${BUCKET}
Voice__S3Region=auto
Voice__S3AccessKey=${HMAC_ID}
Voice__S3SecretKey=${HMAC_SECRET}
Agent__MeetingBotUrl=http://meetbot:8080
Agent__MeetingBotSecret=${MEETBOT_SECRET}
Redis__ConnectionString=redis:6379
Ai__PrimaryProvider=gemini
Ai__Gemini__Enabled=true
Ai__Gemini__Vertex=true
Ai__Gemini__ProjectId=${PROJECT_ID}
Ai__Gemini__Location=${REGION}
Ai__Gemini__Model=${GEMINI_MODEL}
Ai__Gemini__MaxOutputTokens=4096
Ai__Gemini__RequestsPerMinute=120
Ai__Gemini__InputTokensPerMinute=1000000
Ai__Gemini__RequestsPerDay=20000
Ai__Gemini__PilotInputTokenAllowance=2000000000
Ai__Gemini__PilotOutputTokenAllowance=200000000
ENV
chmod 600 "$OUT"

M="$STATE/meetbot.env"
{ grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$STATE/railway-meetbot.env" 2>/dev/null | grep -vE '^(RAILWAY_|PORT=|MEETBOT_API_URL=|MEETBOT_SECRET=|MEETBOT_ALLOW_HTTP=)' || true
  echo "MEETBOT_SECRET=${MEETBOT_SECRET}"; echo "MEETBOT_API_URL=http://api:8080"; echo "MEETBOT_ALLOW_HTTP=true"; } > "$M"
chmod 600 "$M"

cat > "$STATE/compose.env" <<ENV
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
IMAGES=${IMAGES}
TAG=latest
DB_CONNECTION=${CONN}
ENV
echo "Settings written to $STATE (api.env, meetbot.env, compose.env). Review them if you like, then: ./4-migrate.sh"
