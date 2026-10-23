#!/usr/bin/env bash
# Once, in Cloud Shell: lets GitHub Actions deploy (the "Deploy" workflow) instead of running ./update.sh here by hand.
#
# GitHub signs in with Workload Identity Federation: GitHub proves "this is the main branch of projecttrackerindia/project-tracker" and
# Google lets that, and only that, act as a deploy account. No key is created, stored or pasted anywhere.
#
# What it creates (all in this project):
#   - a service account pt-deploy with just what a release needs: Cloud Build (build the images), reading the build logs, signing in to
#     the server over SSH with OS Login, and acting as the server's own account for that sign-in;
#   - a workload identity pool "github" with a provider "github-oidc" that accepts only this repository's main branch;
#   - OS Login on the server (SSH keys tied to Google accounts instead of keys in project metadata; you keep signing in the same way).
# At the end it prints the three values to add in GitHub › Settings › Secrets and variables › Actions › Variables.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
REPOSITORY="${REPOSITORY:-projecttrackerindia/project-tracker}"
DEPLOY_SA_NAME="pt-deploy"
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL="github"; PROVIDER="github-oidc"
NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

echo "== APIs"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudbuild.googleapis.com oslogin.googleapis.com >/dev/null

echo "== Deploy account ${DEPLOY_SA}"
gcloud iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$DEPLOY_SA_NAME" --display-name="ProjectTracker deploys from GitHub" >/dev/null
for role in roles/cloudbuild.builds.editor roles/storage.admin roles/logging.viewer roles/serviceusage.serviceUsageConsumer \
            roles/compute.viewer roles/compute.osAdminLogin roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${DEPLOY_SA}" --role="$role" --condition=None >/dev/null
done
# OS Login on a server that runs as its own account also needs "act as" that account.
gcloud iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser >/dev/null
# Cloud Build runs as the project's build account; submitting a build as pt-deploy needs "act as" it too.
for builder in "${NUMBER}@cloudbuild.gserviceaccount.com" "${NUMBER}-compute@developer.gserviceaccount.com"; do
  gcloud iam service-accounts describe "$builder" >/dev/null 2>&1 && \
    gcloud iam service-accounts add-iam-policy-binding "$builder" --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser >/dev/null || true
done

echo "== GitHub sign-in (only ${REPOSITORY}, main branch)"
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions" >/dev/null
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
    --display-name="GitHub" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${REPOSITORY}' && assertion.ref=='refs/heads/main'" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPOSITORY}" >/dev/null

echo "== OS Login on ${VM_NAME}"
gcloud compute instances add-metadata "$VM_NAME" --zone="$ZONE" --metadata=enable-oslogin=TRUE >/dev/null

cat <<EOF

Done. In GitHub › ${REPOSITORY} › Settings › Secrets and variables › Actions › Variables, add:

  GCP_PROJECT_ID     ${PROJECT_ID}
  GCP_WIF_PROVIDER   projects/${NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
  GCP_DEPLOY_SA      ${DEPLOY_SA}

The website's search-engine verification tags (public in every page, so variables too), as the last build used them:
  GOOGLE_SITE_VERIFICATION   $(grep -m1 '^GOOGLE_SITE_VERIFICATION=' "$STATE/railway-web.env" 2>/dev/null | cut -d= -f2- || true)
  BING_SITE_VERIFICATION     $(grep -m1 '^BING_SITE_VERIFICATION=' "$STATE/railway-web.env" 2>/dev/null | cut -d= -f2- || true)
  INDEXNOW_KEY               $(grep -m1 '^INDEXNOW_KEY=' "$STATE/railway-web.env" 2>/dev/null | cut -d= -f2- || true)
(leave out any that is empty)

From then on, every green CI run on main deploys itself (Actions › Deploy), and it can be started by hand there too.
EOF
