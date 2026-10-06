#!/usr/bin/env bash
# Builds the Android app (an APK) from this folder. Needs Node 20+, JDK 17 and the Android SDK (ANDROID_HOME). Used by the release workflow.
#
#   PT_APP_URL=https://your-site.example.com  ANDROID_KEYSTORE=./release.keystore  ANDROID_KEYSTORE_PASSWORD=...  ANDROID_KEY_ALIAS=projecttracker  bash build.sh
#
# Without a keystore the APK is built unsigned (it cannot be installed): see make-keystore.sh to create one.
set -euo pipefail
cd "$(dirname "$0")"
URL="${PT_APP_URL:-https://projecttracker.in}"
VERSION="${APP_VERSION:-1.0.0}"
CODE="${APP_VERSION_CODE:-1}"

npm ci --no-audit --no-fund
# The address the app opens, and the pages it may move to (sign-in providers, the payment window).
HOST="${URL#*://}"; HOST="${HOST%%/*}"
node -e "
const fs=require('fs');const c=JSON.parse(fs.readFileSync('capacitor.config.json','utf8'));
c.server.url='${URL}';c.server.allowNavigation=[...new Set(['${HOST}',...c.server.allowNavigation])];
fs.writeFileSync('capacitor.config.json',JSON.stringify(c,null,2));"

[ -d android ] || npx cap add android
npx cap sync android

# Name and version
sed -i "s/versionCode [0-9]*/versionCode ${CODE}/; s/versionName \"[^\"]*\"/versionName \"${VERSION}\"/" android/app/build.gradle

# Icon: the maskable icon (it has its own safe margin) for the adaptive icon, the plain one for older phones.
if command -v convert >/dev/null 2>&1; then
  declare -A SIZES=([mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192)
  for d in "${!SIZES[@]}"; do
    dir="android/app/src/main/res/mipmap-$d"; mkdir -p "$dir"; s=${SIZES[$d]}
    convert icons/icon-512.png -resize ${s}x${s} "$dir/ic_launcher.png"; cp "$dir/ic_launcher.png" "$dir/ic_launcher_round.png"
    convert icons/icon-maskable-512.png -resize $((s*9/4))x$((s*9/4)) "$dir/ic_launcher_foreground.png"
  done
  sed -i 's#<color name="ic_launcher_background">[^<]*</color>#<color name="ic_launcher_background">\#7c3aed</color>#' android/app/src/main/res/values/ic_launcher_background.xml 2>/dev/null || true
fi

(cd android && ./gradlew --no-daemon assembleRelease)
UNSIGNED="android/app/build/outputs/apk/release/app-release-unsigned.apk"
OUT="ProjectTracker.apk"
if [ -n "${ANDROID_KEYSTORE:-}" ] && [ -f "${ANDROID_KEYSTORE}" ]; then
  BT="$(ls -d "${ANDROID_HOME:?ANDROID_HOME is not set}"/build-tools/* | sort -V | tail -1)"
  "$BT/zipalign" -f -p 4 "$UNSIGNED" aligned.apk
  "$BT/apksigner" sign --ks "$ANDROID_KEYSTORE" --ks-pass env:ANDROID_KEYSTORE_PASSWORD --ks-key-alias "${ANDROID_KEY_ALIAS:-projecttracker}" --out "$OUT" aligned.apk
  "$BT/apksigner" verify "$OUT"
  rm -f aligned.apk
  echo "Built and signed $OUT"
else
  cp "$UNSIGNED" ProjectTracker-unsigned.apk
  echo "No keystore given: built ProjectTracker-unsigned.apk (it cannot be installed until it is signed)."
fi
