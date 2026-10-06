#!/usr/bin/env bash
# Creates the key that signs the Android app. Do this ONCE and keep the file and its password safe:
# every future version must be signed with the same key, or phones will refuse to update the app.
#
#   bash make-keystore.sh
#
# Then add three secrets to the GitHub repository (Settings -> Secrets and variables -> Actions):
#   ANDROID_KEYSTORE_BASE64    the output of:  base64 -w0 projecttracker-release.keystore
#   ANDROID_KEYSTORE_PASSWORD  the password you typed below
#   ANDROID_KEY_ALIAS          projecttracker
# For push notifications also add  ANDROID_GOOGLE_SERVICES_BASE64  (your Firebase project's google-services.json, base64 -w0); see deploy/DEPLOY.md.
# Never commit the keystore (it is in .gitignore).
set -euo pipefail
keytool -genkeypair -v -keystore projecttracker-release.keystore -alias projecttracker -keyalg RSA -keysize 4096 -validity 36500 \
  -dname "CN=Project Tracker, O=Project Tracker, C=IN"
echo
echo "Created projecttracker-release.keystore. Now run:  base64 -w0 projecttracker-release.keystore"
