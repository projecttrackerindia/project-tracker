# Moving ProjectTracker to Google Cloud (Mumbai, one server)

Everything runs on one server in Mumbai (`asia-south1`), with the database and files on Google's managed services:

| Part | Where | About |
|---|---|---|
| App, website, meeting bot, HTTPS | One Compute Engine server `pt-app` (e2-medium, 2 vCPU, 4 GB) | ~₹2,500 a month |
| Database | Cloud SQL for PostgreSQL 18 (`db-f1-micro`), daily backups for 14 days, point-in-time recovery | ~₹1,000 a month |
| Uploaded files and call recordings | Cloud Storage bucket `<project>-pt-files` in Mumbai | a few rupees per GB |
| AI (assistant, AI employee, project agent) | Gemini on Vertex AI in Mumbai, signed in as the server (no API key) | pay per use, from the credits |
| Shared cache and AI limits | Redis container on the same server | included |
| Logs | Cloud Logging (Logs Explorer) | free allowance |

Free-trial or other Google Cloud credits are used automatically by the project's billing account. Check under Billing › Credits.

**Downtime:** about 15–30 minutes, between turning on maintenance mode (step 4) and the domain switch (step 6). During that time people can still read; changes are paused.

## Before you start

- A Google Cloud project with billing turned on (credits attached). Note its **project id**.
- Access to the DNS settings of `projecttracker.in`. A day before, lower the A record's TTL to 300 seconds so the switch is quick.
- Open **Cloud Shell** (the `>_` button in the Google Cloud console). Every command below runs there, signed in as you. No keys are pasted anywhere.

## 1. Get the code and create everything (about 10 minutes)

```bash
gh auth login                         # or use a GitHub personal access token when git asks
git clone https://github.com/projecttrackerindia/project-tracker.git && cd project-tracker/deploy/gcp
export PROJECT_ID=your-project-id     # put the same line in ~/.bashrc so new Cloud Shell sessions have it
./1-setup.sh
```

This creates the image registry, database, bucket, server, fixed address and firewall in Mumbai. It prints the server's address.

## 2. Build the app (about 15–20 minutes the first time)

```bash
./2-build.sh
```

## 3. Bring the settings over from Railway

```bash
npm i -g @railway/cli && railway login --browserless && railway link      # pick the ProjectTracker project, production
railway variables --service API --kv > ~/.pt-gcp/railway-api.env
railway variables --service MeetBot --kv > ~/.pt-gcp/railway-meetbot.env
railway variables --service Postgres --kv > ~/.pt-gcp/railway-postgres.env
railway variables --service FrontEnd --kv > ~/.pt-gcp/railway-web.env      # search-engine verification tags
./3-env.sh
./2-build.sh                          # once more, so the website carries those tags
```

The script keeps every Railway setting, including keys for AI, e-mail, payments and speech. It then points the database, files and recordings at Google Cloud. The results stay in `~/.pt-gcp` in your Cloud Shell. If your Railway services have other names, use the names shown by `railway status`.

Check that Gemini answers in Mumbai (and which model to use) before the move:

```bash
./ai-check.sh                     # prints "OK: ready"; if the model is not offered in Mumbai, try another: ./ai-check.sh gemini-2.5-flash-lite
GEMINI_MODEL=<model that worked> ./3-env.sh   # only if you picked a different model
```

The Ollama and Redis services on Railway are not moved: Gemini on Vertex AI replaces the self-hosted model (the e2-medium server has no room for it), and Redis runs as a small container on the server.

## 4. The move (maintenance window)

1. In ProjectTracker go to **Admin › Settings** and turn on **Maintenance mode**.
2. Run:

```bash
./4-migrate.sh
```

This copies the database (and prints how many organizations and people arrived), the uploaded files and the call recordings.

## 5. Start on Google Cloud

```bash
./5-start.sh
```

It waits until the API reports healthy, then prints the server address.

## 6. Switch the domain

1. At your DNS provider, set the **A record** of `projecttracker.in` to the address printed in step 5, and the **A record** of `www` to the same address (`www` redirects to the main address). Leave the MX, TXT and other e-mail records alone.
2. Within a few minutes Caddy on the server gets the HTTPS certificate on its own.
3. Open the site, sign in and check a project, a file download and Operations.
4. Turn **Maintenance mode** off. It is part of the database, so it came across already on.
5. In Google Search Console (property `projecttracker.in`), open **Sitemaps** and submit `https://projecttracker.in/sitemap.xml`, then use **URL inspection › Request indexing** on the home page.
6. Keep the Railway project for a week without deleting it. To go back, point the A record at Railway again. After that week, delete the Railway project: nothing on Google Cloud depends on it.

## Day to day

- **Release a new version:** `cd ~/project-tracker/deploy/gcp && ./update.sh` (builds, then restarts with about a minute of interruption).
- **Logs:** Cloud console › Logging › Logs Explorer, filter by `pt-app`.
- **Shell on the server:** `gcloud compute ssh pt-app --zone asia-south1-a`, then `cd /opt/pt && sudo docker compose ps`.
- **Backups:** Cloud SQL › `pt-db` › Backups (daily, 14 days, point-in-time restore). Files are in the bucket.
- **Grow later:** `DB_TIER=db-g1-small` (database) or a bigger server (`gcloud compute instances set-machine-type`). Both need a short restart.

## What changes for connected apps

Claude and ChatGPT connectors keep using `https://projecttracker.in/api/v1/mcp`. Nothing to change in the directory listings.
