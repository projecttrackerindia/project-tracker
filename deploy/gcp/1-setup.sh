#!/usr/bin/env bash
# Step 1 (once): creates everything in Mumbai - image registry, database, file bucket, server, address and firewall.
# Safe to run again: anything that already exists is left alone.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh

echo "== Turning on the Google Cloud services"
gcloud services enable compute.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  storage.googleapis.com iam.googleapis.com logging.googleapis.com monitoring.googleapis.com aiplatform.googleapis.com

echo "== Image registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" --description="ProjectTracker images"

echo "== Service account for the server"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || gcloud iam service-accounts create "$SA_NAME" --display-name="ProjectTracker server"
for role in roles/cloudsql.client roles/artifactregistry.reader roles/logging.logWriter roles/monitoring.metricWriter roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$role" --condition=None >/dev/null
done

echo "== File bucket (uploads and call recordings)"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null
if [ ! -s "$STATE/hmac" ]; then
  # The app talks to the bucket through its S3-compatible interface, with an HMAC key of the service account.
  gcloud storage hmac create "$SA" --format='value(metadata.accessId,secret)' > "$STATE/hmac"
  chmod 600 "$STATE/hmac"
fi

echo "== Database (Cloud SQL for PostgreSQL 18, daily backups kept 14 days, point-in-time recovery)"
if ! gcloud sql instances describe "$DB_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$DB_INSTANCE" --database-version=POSTGRES_18 --edition=ENTERPRISE --tier="$DB_TIER" --region="$REGION" \
    --storage-type=SSD --storage-size=10 --storage-auto-increase --availability-type=zonal \
    --backup-start-time=20:30 --retained-backups-count=14 --enable-point-in-time-recovery
fi
gcloud sql databases describe "$DB_NAME" --instance="$DB_INSTANCE" >/dev/null 2>&1 || gcloud sql databases create "$DB_NAME" --instance="$DB_INSTANCE"
if [ ! -s "$STATE/db-password" ]; then
  openssl rand -base64 30 | tr -d '/+=\n' > "$STATE/db-password"; chmod 600 "$STATE/db-password"
  gcloud sql users create "$DB_USER" --instance="$DB_INSTANCE" --password="$(cat "$STATE/db-password")"
fi

echo "== Fixed public address and firewall"
gcloud compute addresses describe pt-ip --region="$REGION" >/dev/null 2>&1 || gcloud compute addresses create pt-ip --region="$REGION"
gcloud compute firewall-rules describe pt-web >/dev/null 2>&1 || \
  gcloud compute firewall-rules create pt-web --allow=tcp:80,tcp:443 --target-tags=pt-web --description="HTTPS for ProjectTracker"

echo "== Server"
if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" --zone="$ZONE" --machine-type="$VM_TYPE" \
    --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-balanced \
    --service-account="$SA" --scopes=cloud-platform --tags=pt-web --address=pt-ip \
    --metadata-from-file=startup-script=vm-startup.sh
fi

IP=$(gcloud compute addresses describe pt-ip --region="$REGION" --format='value(address)')
echo
echo "Done. Server address: $IP"
echo "Next: ./2-build.sh"
