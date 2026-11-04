# ProjectTracker for iPhone and iPad (TestFlight / App Store)

`apps/ios` is a Capacitor 8 shell (Swift Package Manager, no CocoaPods) that opens https://projecttracker.in in a native WebView, same as `apps/android`.
Until it ships, iPhone users install the PWA (Safari → Share → Add to Home Screen); the `/download` page says so.

## What you need (cannot be automated from this repo)
- A Mac with Xcode 16+ and Node 22+.
- An **Apple Developer Program** membership (USD 99/year) on the account that will own the app.
- In App Store Connect: a new app with bundle id `in.projecttracker.app` (register it under Certificates, Identifiers & Profiles first).

Nothing secret is committed: no certificates, provisioning profiles, `GoogleService-Info.plist` or API keys (see `apps/ios/.gitignore`).

## Build and upload
```bash
cd apps/ios
npm ci
npx cap sync ios          # copies www/ + capacitor.config.json into ios/App/App, resolves the Swift packages
npx cap open ios          # opens ios/App/App.xcodeproj in Xcode
```
In Xcode:
1. Target **App** → *Signing & Capabilities*: pick your Team, keep "Automatically manage signing".
2. Add capabilities: **Push Notifications**, **Background Modes → Remote notifications**, and **Associated Domains** with `applinks:projecttracker.in` (only once `/.well-known/apple-app-site-association` is served, see below).
3. *General*: set Version (e.g. `1.0.0`) and Build (increase for every upload).
4. Choose *Any iOS Device (arm64)* → **Product → Archive** → *Distribute App* → **App Store Connect** → Upload.
5. In App Store Connect → TestFlight: add internal testers (immediate) or an external group (needs a short Beta App Review).
6. For the App Store: screenshots (6.9" and 13" iPad), privacy questionnaire, support URL `https://projecttracker.in/contact/`, account-deletion URL `https://projecttracker.in/delete-account/` (required by Apple), then *Submit for Review*.

## Push notifications
The web app already registers for push through `@capacitor/push-notifications` (see `frontend/src/lib/native.ts`).
For iOS: create an **APNs Auth Key (.p8)** in the developer portal and either upload it to Firebase (if you route iOS through FCM, then add `GoogleService-Info.plist` locally, never committed) or configure the backend's APNs sender with it. Keep the key in your secret store, not in git.

## Deep links
- `projecttracker://…` is registered in `Info.plist` (works now).
- Universal links (`https://projecttracker.in/...` opening the app) need `frontend/public/.well-known/apple-app-site-association` with your Team ID: `{"applinks":{"details":[{"appIDs":["TEAMID.in.projecttracker.app"],"components":[{"/":"/*"}]}]}}` plus the Associated Domains capability above.

## Updating the icon / launch screen
`node frontend/site/make-app-assets.mjs` regenerates `apps/ios/icons/AppIcon-1024.png`; copy it to `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.

## Review notes
Apple rejects pure "website wrappers" (guideline 4.2). The shell adds native push, the share sheet, camera/microphone prompts and offline start; mention these in the review notes, and give the reviewer a demo login.
