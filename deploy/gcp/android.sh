#!/usr/bin/env bash
# Builds the Android app on Google Cloud and puts it in the bucket: ProjectTracker.aab for Google Play, ProjectTracker.apk for the website.
#   ./android.sh            (version 1.0.<build>)       ./android.sh 1.2.0
# The first run creates the signing ("upload") key and keeps it, with its password, in Secret Manager. Keep using the same key:
# Google Play accepts updates only from it (with Play App Signing it can be reset through Play support if ever lost).
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
gcloud services enable secretmanager.googleapis.com cloudbuild.googleapis.com >/dev/null

if ! gcloud secrets describe android-keystore >/dev/null 2>&1; then
  echo "== Creating the Android signing key (once)"
  T=$(mktemp -d); PASS=$(openssl rand -base64 30 | tr -d '/+=\n')
  keytool -genkeypair -keystore "$T/ks" -alias projecttracker -keyalg RSA -keysize 4096 -validity 36500 \
    -storepass "$PASS" -keypass "$PASS" -dname "CN=Project Tracker, O=Project Tracker, C=IN" >/dev/null 2>&1
  base64 -w0 "$T/ks" | gcloud secrets create android-keystore --data-file=- --replication-policy=automatic >/dev/null
  printf %s "$PASS" | gcloud secrets create android-keystore-password --data-file=- --replication-policy=automatic >/dev/null
  rm -rf "$T"; unset PASS
fi
# Push notifications in the app need the Firebase google-services.json; without it the app is built without push.
gcloud secrets describe android-google-services >/dev/null 2>&1 || printf none | gcloud secrets create android-google-services --data-file=- --replication-policy=automatic >/dev/null

# Whoever runs Cloud Build reads these three secrets and writes to the bucket.
SA=$(gcloud builds get-default-service-account --format='value(serviceAccountEmail)' 2>/dev/null | sed 's#.*/##')
for s in android-keystore android-keystore-password android-google-services; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null

VERSION="${1:-1.0.$(date -u +%y%m%d%H)}"
# Google Play needs a whole number that grows with every upload: minutes since 1 January 2026.
CODE=$(( ($(date -u +%s) - 1767225600) / 60 ))
cd ../..
gcloud builds submit --region="${BUILD_REGION:-global}" --config=deploy/gcp/cloudbuild-android.yaml \
  --substitutions="_IMAGES=${IMAGES},_BUCKET=${BUCKET},_SITE_URL=https://${DOMAIN},_VERSION=${VERSION},_VERSION_CODE=${CODE}" .
echo
echo "Done: version ${VERSION} (code ${CODE})."
echo "  Google Play:  gs://${BUCKET}/releases/android/${VERSION}/ProjectTracker.aab"
echo "  Website APK:  gs://${BUCKET}/releases/android/${VERSION}/ProjectTracker.apk"
echo "Download to your computer:  gcloud storage cp gs://${BUCKET}/releases/android/${VERSION}/ProjectTracker.aab ~ && cloudshell download ~/ProjectTracker.aab"
echo "Upload key fingerprint (Play Console asks for nothing; App links use the Play signing key's SHA-256 from Play Console):"
gcloud secrets versions access latest --secret=android-keystore | base64 -d > /tmp/ks.$$ && \
  keytool -list -v -keystore /tmp/ks.$$ -storepass "$(gcloud secrets versions access latest --secret=android-keystore-password)" 2>/dev/null | grep -m1 'SHA256:'; rm -f /tmp/ks.$$
