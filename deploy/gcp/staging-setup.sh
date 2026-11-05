#!/usr/bin/env bash
# Once, in Cloud Shell: a small staging server for staging.projecttracker.in, separate from production in every way that matters:
#   - its own VM (pt-staging, e2-small) running as its own account that can only PULL images and WRITE logs (no Cloud SQL, no bucket,
#     no KMS, no Secret Manager);
#   - its own PostgreSQL in a container, filled with the fictional demo organisation (Seed__Demo), never a copy of production;
#   - email in "Log" mode and payments in "Mock" mode; every page served with X-Robots-Tag: noindex.
# Then point staging.projecttracker.in (A record) at the address this prints, and run ./github-deploy-setup.sh with STAGING=1
# so GitHub can deploy the release branch and labelled pull requests there.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
STAGING_VM="${STAGING_VM:-pt-staging}"
STAGING_DOMAIN="${STAGING_DOMAIN:-staging.${DOMAIN}}"
STAGING_SA="pt-staging@${PROJECT_ID}.iam.gserviceaccount.com"

echo "== Staging server account (pull images, write logs; nothing else)"
gcloud iam service-accounts describe "$STAGING_SA" >/dev/null 2>&1 || gcloud iam service-accounts create pt-staging --display-name="ProjectTracker staging server"
for role in roles/artifactregistry.reader roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${STAGING_SA}" --role="$role" --condition=None >/dev/null
done

echo "== Address and server"
gcloud compute addresses describe pt-staging-ip --region="$REGION" >/dev/null 2>&1 || gcloud compute addresses create pt-staging-ip --region="$REGION"
gcloud compute instances describe "$STAGING_VM" --zone="$ZONE" >/dev/null 2>&1 || \
  gcloud compute instances create "$STAGING_VM" --zone="$ZONE" --machine-type="${STAGING_VM_TYPE:-e2-small}" \
    --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=20GB --boot-disk-type=pd-balanced \
    --service-account="$STAGING_SA" --scopes=cloud-platform --tags=pt-web --address=pt-staging-ip \
    --metadata-from-file=startup-script=vm-startup.sh --metadata=enable-oslogin=TRUE

echo "== Settings (made here, kept only on the staging server)"
rnd() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
T="$STATE/staging"; mkdir -p "$T" && chmod 700 "$T"
DBPW=$(rnd 32)
cat > "$T/.env" <<ENV
COMPOSE_FILE=docker-compose.yml:docker-compose.staging.yml
DOMAIN=${STAGING_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
IMAGES=${IMAGES}
TAG=latest
DB_CONNECTION=unused-on-staging
STAGING_DB_PASSWORD=${DBPW}
ENV
cat > "$T/api.env" <<ENV
ASPNETCORE_ENVIRONMENT=Production
Database__Provider=Postgres
ConnectionStrings__Default=Host=cloudsql;Port=5432;Database=projectmanagement;Username=app;Password=${DBPW}
Jwt__SigningKey=$(rnd 64)
Mfa__EncryptionKey=$(head -c 32 /dev/urandom | base64)
App__WebBaseUrl=https://${STAGING_DOMAIN}
Cors__Origins__0=https://${STAGING_DOMAIN}
Proxy__Trust=true
Storage__Provider=Local
Storage__LocalPath=/app/data/files
Redis__ConnectionString=redis:6379
Webhooks__AllowPrivateTargets=false
ENV
: > "$T/meetbot.env"
chmod 600 "$T"/.env "$T"/api.env

echo "Waiting for Docker on ${STAGING_VM}..."
until gcloud compute ssh "$STAGING_VM" --zone="$ZONE" --command='command -v docker >/dev/null && docker compose version >/dev/null' --quiet 2>/dev/null; do sleep 15; done
gcloud compute scp --zone="$ZONE" --quiet docker-compose.yml docker-compose.staging.yml Caddyfile Caddyfile.staging vm-release.sh \
  "$T/.env" "$T/api.env" "$T/meetbot.env" "$STAGING_VM":/tmp/
gcloud compute ssh "$STAGING_VM" --zone="$ZONE" --quiet --command='set -e
  sudo mkdir -p /opt/pt && cd /tmp && sudo mv docker-compose.yml docker-compose.staging.yml Caddyfile Caddyfile.staging vm-release.sh api.env meetbot.env .env /opt/pt/
  sudo chmod 600 /opt/pt/api.env /opt/pt/meetbot.env /opt/pt/.env
  cd /opt/pt && sudo docker compose pull -q && sudo docker compose up -d && sudo docker compose ps'
rm -f "$T/api.env"   # the server has it; nothing secret stays in Cloud Shell longer than needed
IP=$(gcloud compute addresses describe pt-staging-ip --region="$REGION" --format='value(address)')
echo
echo "Staging is starting. Point ${STAGING_DOMAIN} (A record) to ${IP}. Sign in with the fictional demo account demo@example.com (password in DemoSeeder, backend/.../DatabaseInitializer.cs)."
