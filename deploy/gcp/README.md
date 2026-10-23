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

Create a Railway token (railway.com › Account › Tokens; a workspace token works) and store it as a Secret Manager secret named
`railway-token` in this project (Security › Secret Manager › Create secret). Nothing is typed into Cloud Shell or chat. Then:

```bash
./railway-export.sh                 # every service's settings into ~/.pt-gcp/railway-*.env (prints only counts)
./3-env.sh                          # Google Cloud settings; anything still pointing at Railway is listed and left out
./2-build.sh                        # once more, so the website carries the search-engine verification tags
./ai-check.sh                       # Gemini answers through Vertex AI in Mumbai ("OK: ready")
```

Railway's Ollama and Redis are not moved: Gemini on Vertex AI replaces the self-hosted model and Redis runs on the server.
Cloud SQL must run the same PostgreSQL major version as Railway (18 at the time of the move).

## 4. The move (maintenance window)

```bash
./railway-db-proxy.sh on            # a temporary public address for the Railway database (password protected)
REHEARSAL=1 ./4-migrate.sh          # optional trial while the site stays live (only reads Railway)
FILES_ONLY=1 ./4-migrate.sh         # optional: copy files and recordings ahead of time (repeatable, only changes)
```

Then turn on **Maintenance mode** (Admin › Settings) and run `./4-migrate.sh`. It copies the database (printing how many
organizations and people arrived), then the files and recordings that changed. It took under 3 minutes for the first move.

## 5. Start on Google Cloud

```bash
./5-start.sh
```

It waits until the API reports healthy, then prints the server address.

## 6. Switch the domain

1. At your DNS provider, set the **A record** of `projecttracker.in` to the address printed in step 5, and the **A record** of `www` to the same address (`www` redirects to the main address). Leave the MX, TXT and other e-mail records alone.
2. Within a few minutes Caddy on the server gets the HTTPS certificate on its own.
3. Open the site, sign in and check a project, a file download and Operations.
4. Turn **Maintenance mode** off on the new site (Admin › Settings). It came across already on. Leave it ON in Railway, so anyone whose DNS is still cached sees a read-only copy instead of making changes that would be lost.
5. Close the temporary database address: `./railway-db-proxy.sh off`.
6. In Google Search Console (property `projecttracker.in`), open **Sitemaps** and submit `https://projecttracker.in/sitemap.xml`, then use **URL inspection › Request indexing** on the home page.
7. Keep the Railway project for a week without deleting it. To go back, point the A record at Railway again. After that week, delete the Railway project: nothing on Google Cloud depends on it.

## Video calls on our own server (optional, about 10 minutes)

Once the app is running, `./calls.sh` sets up our own media server (LiveKit) on a second machine, `pt-calls`, at `calls.<domain>`, and
switches on the Call buttons. It asks you to add one DNS record (`calls.<domain>` → the address it prints) and waits for it. The project
agent joins these calls by itself (no lobby, no one has to let it in) and writes the minutes. Details, ports, growing and costs:
[docs/VIDEO-CALLS.md](../../docs/VIDEO-CALLS.md).

## Day to day

- **Release a new version:** `cd ~/project-tracker/deploy/gcp && ./update.sh` (builds, then restarts with about a minute of interruption).
- **Logs:** Cloud console › Logging › Logs Explorer, filter by `pt-app`.
- **Shell on the server:** `gcloud compute ssh pt-app --zone asia-south1-a`, then `cd /opt/pt && sudo docker compose ps`.
- **Backups:** Cloud SQL › `pt-db` › Backups (daily, 14 days, point-in-time restore). Files are in the bucket.
- **Grow later:** `DB_TIER=db-g1-small` (database) or a bigger server (`gcloud compute instances set-machine-type`). Both need a short restart.

## Releases from GitHub (no Cloud Shell needed)

Once, in Cloud Shell:

```bash
cd ~/project-tracker/deploy/gcp && ./github-deploy-setup.sh
```

It creates a deploy account that GitHub's main branch, and nothing else, may act as (Workload Identity Federation: no key exists to leak),
turns on OS Login for the server, and prints three values. Add them in GitHub › Settings › Secrets and variables › Actions › **Variables**:
`GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA` (and the website's verification tags it prints, if any).

From then on every green CI run on main is released by the **Deploy** workflow (Actions › Deploy shows each release; it can also be run by
hand). `./update.sh` in Cloud Shell keeps working as before.

## What changes for connected apps

Claude and ChatGPT connectors keep using `https://projecttracker.in/api/v1/mcp`. Nothing to change in the directory listings.
