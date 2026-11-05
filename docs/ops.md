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
