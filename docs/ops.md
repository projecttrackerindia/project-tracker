# Operations: deploys, rollback, staging, uptime, backups, errors, speed

Everything here is code and config in the repo. Nothing in this file contains a secret: where a secret is needed, this page names the
GitHub secret / variable or Google Secret Manager entry the owner creates. Project: `central-weft-511003-c1`, region `asia-south1`.

## 1. Deploys and rollback

**How a release goes live**

1. A push to `main` runs **CI**. When CI finishes green, **Deploy** (`.github/workflows/deploy.yml`) starts by itself (`workflow_run`).
   It only ships the exact commit CI passed; if `main` has moved on, the newer commit's own run ships that.
2. GitHub signs in to Google Cloud with Workload Identity Federation (no key exists anywhere) and runs `deploy/gcp/update.sh`:
   Cloud Build builds the `api`, `web` and `meetbot` images, tagged with the short commit id (and `latest`), into Artifact Registry
   `asia-south1-docker.pkg.dev/<project>/pt`.
3. On the server, `deploy/gcp/vm-release.sh <tag>` pins `TAG=<tag>` in `/opt/pt/.env`, pulls, checks the nginx config, restarts every
   service except a meeting bot that is in a meeting, and waits up to 5 minutes for `/health/ready`.
   **Migrations**: the API applies EF Core migrations itself as it starts (`Database:AutoMigrate`, on by default), and `/health/ready`
   only answers once the database is reachable, so "ready" means "migrated and serving".
4. If the API does not become ready, the server goes straight back to the previous tag. The workflow then also checks
   `https://projecttracker.in/health/ready` from outside; if that fails (or any step failed), it rolls back to the tag that was live
   before the run.

**Rollback by hand**

- GitHub: Actions › **Rollback** › Run workflow. Leave *tag* empty for "the release before the live one", or give a short commit id.
- Cloud Shell: `cd ~/project-tracker/deploy/gcp && ./rollback.sh` (or `./rollback.sh 1a2b3c4`).
- `./update.sh` keeps working exactly as before (build + release from Cloud Shell), now with the same health check and automatic return.

> Rolling back the images does **not** roll back the database. Migrations must stay backward compatible for one release
> (add columns/tables first, remove them a release later), so the previous image still runs on the newer schema.

**One-time setup (owner, in Cloud Shell)**

```bash
cd ~/project-tracker && git pull
export PROJECT_ID=central-weft-511003-c1
./deploy/gcp/github-deploy-setup.sh        # creates pt-deploy SA, the "github" WIF pool + provider (main branch only), OS Login
```

Equivalent raw commands, if you prefer to run them yourself:

```bash
PROJECT_ID=central-weft-511003-c1; NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudbuild.googleapis.com oslogin.googleapis.com
gcloud iam service-accounts create pt-deploy --display-name="ProjectTracker deploys from GitHub"
for r in roles/cloudbuild.builds.editor roles/storage.admin roles/logging.viewer roles/serviceusage.serviceUsageConsumer \
         roles/compute.viewer roles/compute.osAdminLogin roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:pt-deploy@$PROJECT_ID.iam.gserviceaccount.com --role=$r --condition=None; done
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github-oidc --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
  --attribute-condition="assertion.repository=='projecttrackerindia/project-tracker' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding pt-deploy@$PROJECT_ID.iam.gserviceaccount.com --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/projecttrackerindia/project-tracker"
```

Then in GitHub › Settings › Secrets and variables › Actions › **Variables**: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`
(`projects/<number>/locations/global/workloadIdentityPools/github/providers/github-oidc`), `GCP_DEPLOY_SA`
(`pt-deploy@<project>.iam.gserviceaccount.com`). Create a GitHub **environment** `production` (optionally with required reviewers).
Until `GCP_WIF_PROVIDER` is set, Deploy and Rollback do nothing.

## 2. Staging (staging.projecttracker.in)

A separate small VM (`pt-staging`) running the same images through `deploy/gcp/docker-compose.staging.yml`:

- its own PostgreSQL container (named `cloudsql` so the API's connection string is unchanged) seeded with the **fictional** demo
  organisation (`Seed__Demo=true`, sign in as `demo@example.com`); no Cloud SQL, no bucket, no KMS, no production secrets;
- email `Log`, payments `Mock`, no meeting bot;
- `Caddyfile.staging` sends `X-Robots-Tag: noindex, nofollow, noarchive` on every response and a `Disallow: /` robots.txt;
- images are tagged `s-<commit>` and `staging`; `latest` (production) is never moved by a staging build.

**What deploys there** (`.github/workflows/staging.yml`): every push to `release-*` (e.g. `release-nov`), pull requests from this
repository that carry the label **staging**, and manual runs. The workflow checks `/health/ready`, the noindex header and robots.txt.
From Cloud Shell: `TARGET=staging ./deploy/gcp/update.sh`.

**One-time setup (owner)**

```bash
export PROJECT_ID=central-weft-511003-c1
./deploy/gcp/staging-setup.sh                 # VM pt-staging + address pt-staging-ip + pt-staging SA (pull images, write logs only)
STAGING=1 ./deploy/gcp/github-deploy-setup.sh # separate WIF pool "github-staging" + pt-staging-deploy SA (SSH to pt-staging only)
```

DNS: an `A` record `staging` → the printed address. GitHub variables: `GCP_STAGING_WIF_PROVIDER`, `GCP_STAGING_DEPLOY_SA`
(and `STAGING_VM` if renamed). Create the GitHub environment `staging` and the PR label `staging`.

The staging pool is separate on purpose: a token from a pull request can never act as the production deploy account.
Caveat: a same-repository PR labelled `staging` runs its own `cloudbuild.yaml` with the Cloud Build account, so only label PRs you trust.
