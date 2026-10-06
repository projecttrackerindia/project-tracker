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

```sh
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file .env up -d --build
```

Database migrations run automatically at start. To pause changes while you upgrade, turn on **Admin → Platform settings →
Maintenance mode** first (people can still read and sign in; only platform administrators can change data), and switch it off after.
Take a backup right before with `docker compose exec backup sh /backup.sh now`.

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
- **Warnings on first open:** the installers are not signed with a paid certificate, so Windows SmartScreen and macOS Gatekeeper ask for confirmation once. The download page explains the steps.
- **iPhone and iPad:** Apple does not allow installing from a website, so users add the site to the Home Screen from Safari (alerts need iOS 16.4+).
- **Android alerts:** the APK shows the site but has no native push; users who want alerts while the app is closed install the site from Chrome.

## Live chat

Chat keeps a WebSocket open to `/hubs/chat`. The bundled nginx and Caddy already pass it through (long timeouts, no buffering), so nothing is
needed for the setup in this guide. If you put **your own** proxy or load balancer in front, allow WebSocket upgrades on `/hubs/` and do not
close idle connections sooner than a few minutes (the app sends a keep-alive every 15 seconds). Who is online and who is typing are held
in the API's memory, so run **one API container**: several would each see only their own connections.

## Not covered here

Load balancing several API servers (live chat would also need a shared backplane), a managed database, object storage for files (only local disk is built in), single sign-on,
and log/metric shipping. Apart from live chat's online/typing state, the application is stateless apart from the database and the files volume, so those
can be added around it.
