# Publishing the Android app on Google Play

The app is `apps/android` (Capacitor 8, package `in.projecttracker.app`, targets Android 16 / API 36 as Play requires).
It is built and signed on Google Cloud: `cd deploy/gcp && ./android.sh` puts `ProjectTracker.aab` (for Play) and
`ProjectTracker.apk` (for the website) in `gs://<project>-pt-files/releases/android/<version>/`. The signing ("upload") key
and its password live only in Secret Manager (`android-keystore`, `android-keystore-password`).

## 1. One-time setup (the account owner)

1. Create a Google Play developer account at https://play.google.com/console (one-time US$25 fee, identity verification).
   - Choose an **Organization** account if the business has a D-U-N-S number. A new **Personal** account must run a
     closed test with at least 12 testers for 14 days before the app can go to production.
2. **Create app**: name *Project Tracker*, default language English (India), App, Free.
3. Turn on **Play App Signing** (the default) and upload `ProjectTracker.aab` to an *Internal testing* release first.
4. After the first upload, copy the **App signing key certificate SHA-256** (Play Console › Test and release › App integrity)
   and add it to `frontend/public/.well-known/assetlinks.json`, so `https://projecttracker.in/...` links open the app.

## 2. Store listing (copy and paste)

- **App name:** Project Tracker
- **Short description (80):** Projects, tasks, timesheets and support in one workspace, with an AI assistant.
- **Full description:**

  Project Tracker brings your projects, tasks, support desk and documentation into one secure workspace.

  • Projects and tasks with boards, lists, timelines and a portfolio view
  • Reminders, a calendar and timesheets, with alerts on your phone
  • Team chat, meetings with AI minutes, and decisions in one place
  • An operations desk with service levels, for support and IT teams
  • DocTracker for API documentation and architecture
  • An AI assistant that answers from your projects and proposes changes for you to confirm
  • Sign in with passkeys, or approve a sign-in on your computer by tapping a number on your phone

  Your data is hosted in India on Google Cloud (Mumbai). Free for one person; Pro and Business for teams.

- **Category:** Business · **Tags:** project management, productivity, team collaboration
- **Contact e-mail:** support@projecttracker.in · **Website:** https://projecttracker.in
- **Privacy policy:** https://projecttracker.in/privacy
- **Graphics:** icon 512×512 (`apps/android/icons/icon-512.png`), feature graphic 1024×500, at least 2 phone screenshots.

## 3. App content answers

- **App access:** sign-in required. Give reviewers a demo account (a workspace with sample projects) under *App access*.
- **Ads:** no ads. **Content rating:** questionnaire, category *Utility, Productivity, Communication*; user-generated
  content shared within a workspace only. **Target audience:** 18 and over. **News app:** no. **Government app:** no.
- **Account deletion:** in the app, Account › Profile › Delete my account; on the web: https://projecttracker.in/delete-account/
- **Data safety:**
  - Collected: name, e-mail address, user IDs; photos and files people upload; messages (team chat); audio when an administrator
    tries the voice agent from the app (microphone); app interactions; device or other IDs (push notification token).
  - Purpose: app functionality and account management; analytics only to run and secure the service. Not used for ads.
  - Shared: not sold. Processed by service providers on our behalf (Google Cloud hosting and Gemini AI, Firebase Cloud
    Messaging for alerts, Google Workspace and Resend for e-mail), which Play treats as *not shared*.
  - Encrypted in transit: yes. People can request deletion: yes (see above).

## 4. Each new version

```bash
cd ~/project-tracker && git pull && cd deploy/gcp && ./android.sh 1.1.0
gcloud storage cp gs://<project>-pt-files/releases/android/1.1.0/ProjectTracker.aab ~ && cloudshell download ~/ProjectTracker.aab
```

Upload the `.aab` to a new release in Play Console. The app shows the live website, so most changes reach phones without a
new release; a new release is needed only for native changes (plugins, permissions, icon, Android version).
