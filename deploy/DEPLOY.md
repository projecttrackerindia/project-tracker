# Going live

A step-by-step for putting this on a server that real people will use. Budget about an hour. Everything here was exercised on the
Docker stack except the parts that need the public internet (DNS, certificate issuance, your mail provider), which are marked.

## What you need

- A Linux server (or VM) with **Docker** and **Docker Compose v2**, 2 GB RAM or more, and disk for your files and backups.
- A **domain name** whose DNS points at the server, and ports **80 and 443** open to the internet.
- **SMTP details** from a mail provider (verification, invitation, password-reset and notification e-mails need them).

## 1. Configure

```sh
git clone <your repository> project-management && cd project-management
cp deploy/.env.production.example .env
```

Edit `.env` and fill in **every** value. Generate the secrets (and store them in a password manager):

```sh
openssl rand -base64 36    # POSTGRES_PASSWORD
openssl rand -base64 48    # JWT_SIGNING_KEY
openssl rand -base64 48    # MFA_ENCRYPTION_KEY
```

Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` to your own address and a strong temporary password: this creates the first platform
administrator on first start.

> Keep `JWT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` **stable**. Changing the signing key signs everyone out; losing
> the MFA key makes stored authenticator secrets unreadable.

## 2. Start

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file .env up -d --build
```

This starts PostgreSQL, the API, the web app, the **nightly backup** service and **Caddy**, which obtains and renews the HTTPS
certificate for `DOMAIN` by itself (needs the DNS and ports above). Only ports 80 and 443 are published; the database and web
container are unreachable from outside.

Open `https://<your domain>`. First start applies the database migrations automatically.

## 3. Secure the first login

1. Sign in with the seeded administrator.
2. **Settings → Change password** and choose a strong password. (Turn on two-step verification there too.)
3. Remove `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from `.env`, then `docker compose ... up -d` again.

## 4. Check e-mail

Open **Admin → System health**. In the **Go-live checklist**, click **Send test email to me** and confirm it arrives. If it does not,
look at `docker compose logs api` for the SMTP error.

### Support address

Every question goes to one address, **support@projecttracker.in**: the website (footer, Enterprise plan, security report, `security.txt`,
structured data), the app (account menu › *Help & support*, sign-in pages, Billing, legal pages) and the footer of every e-mail. Set
`App__SupportEmail` to change it on the API (e-mail footers and messages such as "write to … with the reference"), and `Email__ReplyTo` to the
same address so replies to system e-mails reach it. The website and app use `SITE.supportEmail` (`frontend/site/content.ts`) and
`SUPPORT_EMAIL` (`frontend/src/lib/support.ts`).

### Payments (before you charge anyone)

Out of the box payments are **simulated**: choosing a paid plan succeeds and nothing real is charged. To take real money with Razorpay:

1. In the Razorpay dashboard create **API keys** (start with the `rzp_test_` pair) and a **webhook** to
   `https://<your site>/api/v1/billing/webhooks/razorpay` with a secret you choose and the events `subscription.activated`,
   `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`.
2. In `.env` set `BILLING_PROVIDER=Razorpay`, `BILLING_RAZORPAY_KEY_ID`, `BILLING_RAZORPAY_KEY_SECRET` and `BILLING_RAZORPAY_WEBHOOK_SECRET`, then redeploy.
3. Pay once with a Razorpay test card from a test workspace, and check the invoice appears under **Settings → Billing**. Only then switch to the `rzp_live_` keys.

How it behaves: the owner pays in Razorpay's window; the plan changes when Razorpay confirms (the signed message is the source of truth, so a closed
browser tab does not lose a payment). Razorpay charges each month and tells the app; a failed charge puts the workspace **Past due** and the owner is
notified; **Cancel** stops the next charge and keeps the plan until the end of the paid month. Switching plans ends the older subscription at once
(there is no proration). Prices shown are what Razorpay charges: if you must add GST, set the plan price accordingly or discuss tax invoicing with
your accountant, because the app does not add tax on top.

### Payments by UPI QR (until Razorpay is connected)

While no payment gateway is connected, paid plans can be paid by scanning a **UPI QR** of one of your own bank accounts. It takes precedence
over Razorpay while it is on, so switch it off (`Billing__Upi__Enabled=false`) when you move to Razorpay.

Set on the API service (Railway variables or `.env`); the UPI IDs stay out of git:

| Variable | What it is |
|---|---|
| `Billing__Upi__Enabled` | `true` to take payments by UPI QR |
| `Billing__Upi__Accounts__0__Id` | the first account's UPI ID (VPA), e.g. `name@okbank`; `__1__`, `__2__` … for the next ones, **in the order they are tried** |
| `Billing__Upi__Accounts__0__Name` | the payee name shown in the UPI app (as on the bank account) |
| `Billing__Upi__Accounts__0__Label` | the bank's name shown to the payer and the administrator, e.g. `Kotak Mahindra Bank` |
| `Billing__Upi__Accounts__0__Enabled` | `false` takes one account out without renumbering (default `true`) |
| `Billing__Upi__FailureThreshold` / `__FailureWindowHours` | skip an account after this many failed payments in this many hours since its last confirmed payment (default 3 in 24) |
| `Billing__Upi__ExpiryHours` | how long a QR stays valid (default 48) |
| `Billing__Upi__NotifyEmail` | also e-mail this address when a payment waits for confirmation (platform administrators always get it) |

How it behaves:

1. The owner chooses a plan in **Settings → Billing** and gets **one QR**: the first account that is not failing. The QR is a standard
   `upi://pay` link with the exact amount and a reference (`PT-XXXXXXX`) as the note, so any UPI app fills everything in.
2. If paying fails, **Payment failed? Try another QR** records the failure against that account and shows the **next account's QR** for the same
   amount. After `FailureThreshold` failures with no confirmed payment since, the account is skipped for new payments (a confirmed payment
   puts it back). If every account is failing, the one with the fewest failures is shown.
3. After paying, the owner enters the **UTR** (UPI transaction id). A UTR can be used once. Platform administrators (and `NotifyEmail`) get an e-mail.
4. In **Admin → UPI payments** an administrator matches the UTR and amount with that bank account's statement and **confirms** (the plan is
   switched on for the paid period, the invoice is recorded, the owner is notified) or **rejects** with a reason the owner sees. The same page
   shows each account's recent failures and which QR is shown first.
5. Nothing renews by itself: at the end of the paid period the workspace goes **Past due** and the owner is asked to pay again (a renewal of the
   same plan extends from the old end date).

A static personal UPI QR cannot be verified automatically, which is why an administrator confirms each payment. Personal accounts also have
daily UPI limits (often ₹1 lakh) and banks may question many business receipts into a savings account; move to Razorpay (or a merchant UPI
account) once volumes grow.

### A staging copy (recommended)

Run a second copy next to production before big changes: clone the repository into another folder, give it its own `.env` (a different `PUBLIC_URL`, port,
database volume and `BILLING_PROVIDER=Mock` or Razorpay **test** keys), start it with `docker compose -p staging ...`, restore last night's backup into it
with `sh deploy/restore.sh <db-file>` (see Backups), and try the upgrade there first. Migrations run when it starts, so you see a failing one before your customers do.

## 5. Work through the go-live checklist

The same page lists what still needs attention, worst first. Each line says what is wrong and how to fix it:

| Check | Means |
|---|---|
| Platform administrator passwords | An admin still uses a well-known password. **Fix first.** |
| Demo accounts | The demo organization (well-known password) exists. Delete or disable it. |
| E-mail delivery | Mail provider is `Log` (nothing is really sent) or SMTP host missing. |
| HTTPS | `APP_URL` is not an `https://` address. |
| Allowed web origins | CORS still lists localhost or plain http. |
| Backups | No database backup, or the newest is over 30 hours old. |
| Database | Default database password, or not PostgreSQL. |
| Token signing key / Authenticator-secret key | Keys too short or not set separately. |
| Rate limiting, Webhook targets, E-mail verification | Safety switches that were turned off. |

The admin **Overview** shows a red notice until nothing is left to fix. Aim for an all-green list.

## 6. Backups

The `backup` service writes to the `backups` Docker volume every night (02:00 UTC by default, `BACKUP_HOUR_UTC`) and keeps
`BACKUP_KEEP_DAYS` (14) days:

- `db-YYYYMMDD-HHMMSS.dump` – the database (PostgreSQL custom format)
- `files-YYYYMMDD-HHMMSS.tgz` – all uploaded files

It also takes one at start-up if there is none from the last 24 hours. Check: `docker compose logs backup`, or the **Backups** line in the
checklist.

**A backup on the same machine is not enough.** Copy the volume somewhere else regularly, for example (cron on the host):

```sh
docker run --rm -v <project>_backups:/b -v /mnt/offsite:/out alpine sh -c 'cp -u /b/db-* /b/files-* /out/'
```

(`docker volume ls` shows the exact volume name.) Object storage, another server or a backup service all work.

### Check that a backup can be restored (do this once now, then now and then)

```sh
sh deploy/restore.sh db-20260101-020000.dump --verify-only
```

This restores into a scratch database, counts the users, and throws it away. It does not touch live data.

### Restore for real

```sh
sh deploy/restore.sh db-20260101-020000.dump files-20260101-020000.tgz
```

You must type `RESTORE` to confirm. It stops the API and web app, **renames the current database** to
`projectmanagement_before_restore_<time>` (so a wrong choice can be undone), restores the backup, restores the files, and starts the
app again. Drop the safety copy when you are sure.

> On Windows with Git Bash, run these with `MSYS_NO_PATHCONV=1` in front (otherwise paths like `/backups` are rewritten).

## 7. Upgrades

**Pricing change (per-person plans):** the first start of this version moves the built-in plans to per-person pricing once (Pro ₹349, Business ₹699 per person per month; storage and AI credits per person, pooled) and gives every paying workspace seats equal to its people, at least 5, so nobody is locked out. A Razorpay subscription made earlier keeps charging its old amount until the owner picks seats in Settings → Billing. Review Admin → Plans, and read `docs/PRICING.md` for the arithmetic (AI cost per credit, margin per person) before changing any number. Discounts and the seat cap are `Billing:Pricing:*`.

```sh
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file .env up -d --build
```

Database migrations run automatically at start. To pause changes while you upgrade, turn on **Admin → Platform settings →
Maintenance mode** first (people can still read and sign in; only platform administrators can change data), and switch it off after.
Take a backup right before with `docker compose exec backup sh /backup.sh now`.

**Adding a migration.** Several shipped migrations carry hand-written identifiers dated ahead of the calendar; the chain's frontier is
`20261104000100`. A migration generated from the clock before that date would sort into the middle of the chain and apply in a different
position on a fresh database than on an upgraded one. Give every new migration an identifier greater than the frontier (the frontier plus
one minute is fine), keep the `[Migration("…")]` attribute and the file name identical, and never rename or remove a migration that has
shipped. `MigrationOrderTests` in the test project refuses a migration that breaks this rule.

## 8. Day-to-day

- **Health:** Admin → System health (database, workers, queues, errors). `GET /health/ready` is suitable for an uptime monitor.
- **Announcements:** Admin → Platform settings → Announcement banner.
- **Logs:** `docker compose logs -f api`.
- **Sign-ups:** Admin → Platform settings → close sign-ups if you only want invited people.

## Desktop and Android apps (free downloads)

The website's `/download/` page links to files on this repository's GitHub Releases. Nothing is hosted on your server.

- **Publish a release:** `git tag v1.0.0 && git push origin v1.0.0`. The *Release apps* workflow builds the Windows installer, macOS disk images (Apple silicon and Intel), Linux AppImage and .deb, the Android APK and `SHA256SUMS.txt`, and attaches them to the release. The page's links point at `releases/latest/download/<fixed file name>`, so they never need editing.
- **App address:** the apps open `https://projecttracker.in`. Change `DEFAULT_URL` in `apps/desktop/src/config.js` and `server.url` in `apps/android/capacitor.config.json` if your domain differs.
- **Android signing:** run `apps/android/make-keystore.sh` once and add the three secrets it prints (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`) under the repository's Actions secrets. Keep the keystore safe: updates must be signed with the same one. Never commit it (this repository is public). Without the secrets the APK step is skipped.
- **Updates:** the Windows app and the Linux AppImage update themselves: they look for a newer release when they start and every few hours, download it quietly (release files `latest.yml` / `latest-linux.yml` carry the checksums) and install it when the app is closed, or at once from Help → Restart to update. Releasing is all it takes: run the workflow with the next version number. macOS cannot replace an app that has no paid Apple certificate, so Mac users get a notice and the new disk image from the Downloads page. Web-app changes (your server) reach every desktop app at once without any release.
- **Warnings on first open:** the installers are not signed with a paid certificate, so Windows SmartScreen and macOS Gatekeeper ask for confirmation once. The download page explains the steps.
- **iPhone and iPad:** Apple does not allow installing from a website, so users add the site to the Home Screen from Safari (alerts need iOS 16.4+).
- **Android alerts (push to the app):** the APK is the same web app in a native shell with push through Firebase Cloud Messaging (free). One-time set-up:
  1. Create a Firebase project (console.firebase.google.com) and add an **Android app** with the package name `in.projecttracker.app`. Download its `google-services.json`.
  2. Add it as the repository secret `ANDROID_GOOGLE_SERVICES_BASE64` (`base64 -w0 google-services.json`). Without it the app is built without push.
  3. In Firebase: Project settings → Service accounts → **Generate new private key**. Give the server that JSON: `PUSH_FCM_SERVICE_ACCOUNT_JSON` in `.env` (the JSON on one line; `Push__FcmServiceAccountFile` takes a mounted file instead). Admin → System health shows nothing more to set; `GET /api/v1/push` reports `nativeEnabled`.
  4. Push a new tag so the APK is rebuilt. Each person then turns alerts on in Account → Mobile app (or Notifications → Push on this device).
  What the app also does: Back goes back and leaves from the first screen, tapped notifications and `https://<your domain>/…` links open the right page, files (invoice PDFs, exports) go to the share sheet, the status bar follows the theme, photos can be attached from the camera or gallery. Passkeys are not offered inside the app (Android's web view has none); phone approval and passwords work.

## Live chat

Chat keeps a WebSocket open to `/hubs/chat`. The bundled nginx and Caddy already pass it through (long timeouts, no buffering), so nothing is
needed for the setup in this guide. If you put **your own** proxy or load balancer in front, allow WebSocket upgrades on `/hubs/` and do not
close idle connections sooner than a few minutes (the app sends a keep-alive every 15 seconds). Who is online and who is typing are held
in the API's memory, so run **one API container**: several would each see only their own connections.

## Project agent: live meeting bot (optional)

The project agent can join Google Meet stand-ups with its own bot (`apps/meetbot`, a small Node service running Chromium). It is not a
third-party service: nothing to buy, no per-meeting fees.

- **How it scales:** the bot service runs as **workers that ask the API for meetings** (every 5 seconds). Each worker attends as many meetings
  at once as its memory and CPUs allow (about 550 MB and half a CPU per meeting; `MEETBOT_MAX_BOTS` overrides). To attend more meetings at
  once, **add replicas** of the bot service: nothing else changes, because workers only ever call the API. When every worker is busy,
  meetings wait in line and are joined as soon as one is free; a worker that stops (crash, redeploy) loses its meetings to another worker,
  which rejoins them within about two minutes. On a redeploy a worker stops taking meetings and stays in the ones it has until they end.
  Admin › System health › *Meeting bots* shows the workers, the meeting slots in use and any sessions waiting.
- **Docker Compose:** set `MEETBOT_SECRET` (any random string of 16+ characters) in `.env`, then `docker compose --profile meetbot up -d`
  (add `--scale meetbot=2` for two workers). The API reads the same secret.
- **Railway (or any container host):** add a service from this repository with root directory `apps/meetbot` (it has its own Dockerfile). On
  it set `MEETBOT_SECRET` and `MEETBOT_API_URL=https://<your site>` (the address the app is served from); on the API service set
  `Agent__MeetingBotSecret=<same secret>`. Give each replica 2-4 GB of memory and 2 vCPUs, set its **draining time to a few hours**
  (Settings › Deploy › Draining seconds, e.g. 10800) so redeploys never cut a meeting short, and raise the replica count for more meetings.
- Without the bot, the agent still reads Google Meet transcripts after each meeting and anything pasted into a project's Agent tab.
- The bot sets Meet's captions to each project's meeting language and posts the project's agenda after its hello (nothing to configure).
- **Beyond a few hundred meetings at once** (1,000 meetings ≈ 250 workers, ~550 GB of memory and ~500 vCPUs): captions are already sent in
  batches (`MEETBOT_CAPTION_FLUSH_MS`, default 3000) and appended in one write, and worker reports cost a few queries whatever their size.
  The next steps are infrastructure, in this order: (1) run the bot workers on autoscaled machines (Kubernetes with KEDA scaling on the
  *waiting* count from Admin › System health, scaled up ~15 minutes before the hour, when most meetings start); (2) put a connection pooler
  (PgBouncer) in front of PostgreSQL and run several API replicas; (3) spread workers over several egress IPs, since Meet may limit many
  guests from one address; (4) where the organizer's Google Workspace includes transcripts, prefer *Use my Google account* - Meet transcribes
  the call itself and no bot or browser is needed - and keep the bot for meetings that need it in the call (answers, reminders, delegation).

## Project agent: mail, Slack, WhatsApp and alerts (optional)

Everything about the project agent — its sources, accuracy settings, minutes, the evaluation set and every setting — is in
[docs/PROJECT-AGENT.md](../docs/PROJECT-AGENT.md). For a deployment, the pieces to switch on are:

- **Project mailbox addresses:** `InboundEmail__Domain` (a domain whose MX points at Mailgun, SendGrid or Postmark inbound) and
  `InboundEmail__Key`; route all mail for that domain to `https://<api host>/api/v1/inbound/email?key=<key>`.
- **Slack channels:** `Slack__AgentChannels=true`, the `channels:history` and `groups:history` scopes on the Slack app, then reconnect Slack.
- **WhatsApp texts to a project key:** `WhatsApp__AgentMessagesEnabled=true` (reception and contact linking must already be on).
- **Failed-deploy e-mails:** `Ops__DeployWebhookToken` (24+ random characters, optional `Ops__AlertEmail`) and a Railway webhook to
  `https://<api host>/api/v1/inbound/deploy/<token>`.

## Not covered here

Load balancing several API servers (live chat would also need a shared backplane), a managed database, object storage for files (only local disk is built in), single sign-on,
and log/metric shipping. Apart from live chat's online/typing state, the application is stateless apart from the database and the files volume, so those
can be added around it.
