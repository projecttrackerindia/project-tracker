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

## Live chat

Chat keeps a WebSocket open to `/hubs/chat`. The bundled nginx and Caddy already pass it through (long timeouts, no buffering), so nothing is
needed for the setup in this guide. If you put **your own** proxy or load balancer in front, allow WebSocket upgrades on `/hubs/` and do not
close idle connections sooner than a few minutes (the app sends a keep-alive every 15 seconds). Who is online and who is typing are held
in the API's memory, so run **one API container**: several would each see only their own connections.

## Not covered here

Load balancing several API servers (live chat would also need a shared backplane), a managed database, object storage for files (only local disk is built in), single sign-on,
and log/metric shipping. Apart from live chat's online/typing state, the application is stateless apart from the database and the files volume, so those
can be added around it.
