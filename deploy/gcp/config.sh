# Settings for the Google Cloud move. Edit PROJECT_ID (and DOMAIN if needed), then every script reads this file.
export PROJECT_ID="${PROJECT_ID:-CHANGE-ME}"            # your Google Cloud project id (Cloud console, top bar)
export REGION="asia-south1"                              # Mumbai
export ZONE="asia-south1-a"
export DOMAIN="${DOMAIN:-projecttracker.in}"
export ACME_EMAIL="${ACME_EMAIL:-support@projecttracker.in}"   # Let's Encrypt contact for the HTTPS certificate
export VM_NAME="pt-app"
export VM_TYPE="${VM_TYPE:-e2-medium}"                   # 2 vCPU (shared), 4 GB
export DB_INSTANCE="pt-db"
export DB_TIER="${DB_TIER:-db-f1-micro}"                 # the smallest managed PostgreSQL; db-g1-small when it grows
export DB_NAME="projectmanagement"
export DB_USER="app"
export BUCKET="${PROJECT_ID}-pt-files"
export REPO="pt"
export SA_NAME="pt-app"
export SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export IMAGES="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
# Secrets made by the scripts (database password, bucket keys) stay in this folder in your Cloud Shell home, never in git.
export STATE="${HOME}/.pt-gcp"
mkdir -p "$STATE" && chmod 700 "$STATE"
if [ "$PROJECT_ID" = "CHANGE-ME" ]; then echo "Set PROJECT_ID first:  export PROJECT_ID=your-project-id" >&2; exit 1; fi
gcloud config set project "$PROJECT_ID" >/dev/null
