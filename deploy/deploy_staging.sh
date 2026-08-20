#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# SeenSnap — staging environment bootstrap for Cloud Run + Cloud SQL.
#
# Idempotent one-shot: every step checks for existing state before creating
# anything. You can run this repeatedly (e.g. after tweaking secrets) and
# it will only do the deltas.
#
# Prerequisites
#   - gcloud installed and authenticated (`gcloud auth login`)
#   - gcloud application-default credentials (`gcloud auth application-default login`)
#   - Billing enabled on the project you choose
#   - Docker running locally (for the initial image build)
#
# Usage
#   deploy/deploy_staging.sh [--project PROJECT_ID] [--region us-central1]
#
# Or set env vars:
#   PROJECT_ID=seensnap-staging REGION=us-central1 deploy/deploy_staging.sh
#
# The script will PROMPT for any secret value it cannot derive (TMDB key,
# Google OAuth Web client id, etc.) unless already in Secret Manager.
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration knobs ────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-seensnap-staging}"
REGION="${REGION:-us-central1}"
INSTANCE_NAME="${INSTANCE_NAME:-seensnap-db-staging}"
INSTANCE_TIER="${INSTANCE_TIER:-db-f1-micro}"       # cheapest shared-core
DB_VERSION="${DB_VERSION:-POSTGRES_16}"
DB_NAME="${DB_NAME:-seensnap}"
DB_APP_USER="${DB_APP_USER:-seensnap_app}"
SERVICE_NAME="${SERVICE_NAME:-seensnap-api-staging}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-seensnap-api-runner}"

# Parse --flag args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)  PROJECT_ID="$2"; shift 2 ;;
    --region)   REGION="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"

log() { printf '\n\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[fatal]\033[0m %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud not found. Install: brew install --cask google-cloud-sdk"
command -v docker >/dev/null || die "docker not found. Install Docker Desktop."

# ─── Auth + project ────────────────────────────────────────────────────
log "Confirming gcloud auth"
CURRENT_ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[[ -n "$CURRENT_ACCOUNT" ]] || die "Not authenticated. Run: gcloud auth login"
echo "  account: $CURRENT_ACCOUNT"

log "Selecting project '$PROJECT_ID'"
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  read -rp "Project '$PROJECT_ID' does not exist. Create it? [y/N] " ANS
  [[ "$ANS" == "y" || "$ANS" == "Y" ]] || die "Aborting. Create a project manually or pass --project."
  gcloud projects create "$PROJECT_ID" --name="SeenSnap Staging"
  warn "Link this project to a billing account in the Cloud Console:"
  warn "  https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
  read -rp "Press ENTER once billing is linked."
fi
gcloud config set project "$PROJECT_ID"

# ─── APIs ───────────────────────────────────────────────────────────────
log "Enabling required APIs (idempotent, may take a minute)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  --project="$PROJECT_ID"

# ─── Service account ────────────────────────────────────────────────────
SA_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
log "Ensuring service account '$SA_EMAIL'"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT" \
    --display-name="SeenSnap staging API runner" \
    --project="$PROJECT_ID"
fi

# Cloud Run needs to talk to Cloud SQL + read Secret Manager.
for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$role" >/dev/null
done

# ─── Cloud SQL instance ────────────────────────────────────────────────
log "Ensuring Cloud SQL instance '$INSTANCE_NAME'"
if ! gcloud sql instances describe "$INSTANCE_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql instances create "$INSTANCE_NAME" \
    --database-version="$DB_VERSION" \
    --tier="$INSTANCE_TIER" \
    --region="$REGION" \
    --storage-type=SSD \
    --storage-size=10GB \
    --no-storage-auto-increase \
    --backup-start-time=07:00 \
    --project="$PROJECT_ID"
else
  echo "  instance exists — skipping create."
fi
INSTANCE_CONNECTION_NAME="${PROJECT_ID}:${REGION}:${INSTANCE_NAME}"

log "Ensuring database '$DB_NAME'"
if ! gcloud sql databases describe "$DB_NAME" --instance="$INSTANCE_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql databases create "$DB_NAME" --instance="$INSTANCE_NAME" --project="$PROJECT_ID"
fi

# Application DB user. Auto-generate password on first run + store as secret.
DB_PASSWORD_SECRET="seensnap-db-password"
log "Ensuring app DB user '$DB_APP_USER'"
if ! gcloud secrets describe "$DB_PASSWORD_SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  DB_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
  printf '%s' "$DB_PASSWORD" | gcloud secrets create "$DB_PASSWORD_SECRET" \
    --data-file=- --project="$PROJECT_ID" \
    --replication-policy=automatic
  gcloud sql users create "$DB_APP_USER" \
    --instance="$INSTANCE_NAME" \
    --password="$DB_PASSWORD" \
    --project="$PROJECT_ID" || warn "user may already exist; you may need to reset the password manually."
else
  DB_PASSWORD="$(gcloud secrets versions access latest --secret="$DB_PASSWORD_SECRET" --project="$PROJECT_ID")"
  echo "  password secret already exists — reusing."
fi

# ─── Backend secrets ────────────────────────────────────────────────────
ensure_prompt_secret() {
  local secret="$1" description="$2"
  if gcloud secrets describe "$secret" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "  secret '$secret' exists — skipping prompt."
    return
  fi
  echo
  echo "Provide value for secret: $secret"
  echo "  purpose: $description"
  read -rsp "  value (input hidden): " val; echo
  [[ -n "$val" ]] || die "Empty value not allowed for $secret."
  printf '%s' "$val" | gcloud secrets create "$secret" \
    --data-file=- --project="$PROJECT_ID" --replication-policy=automatic
}

log "Ensuring backend secrets"
if ! gcloud secrets describe seensnap-app-auth-secret --project="$PROJECT_ID" >/dev/null 2>&1; then
  APP_AUTH_SECRET="$(openssl rand -hex 32)"
  printf '%s' "$APP_AUTH_SECRET" | gcloud secrets create seensnap-app-auth-secret \
    --data-file=- --project="$PROJECT_ID" --replication-policy=automatic
  echo "  generated 64-char APP_AUTH_SECRET."
fi
ensure_prompt_secret "seensnap-tmdb-key" "TMDB API key — themoviedb.org → Settings → API"
ensure_prompt_secret "seensnap-google-oauth-client-id" \
  "Google OAuth Web client ID — Console → APIs & Services → Credentials → OAuth 2.0 Client IDs (type: Web)"

# ─── DATABASE_URL (unix socket) as a secret ────────────────────────────
DB_URL_SECRET="seensnap-database-url"
DB_URL_VALUE="postgresql+psycopg://${DB_APP_USER}:${DB_PASSWORD}@/${DB_NAME}?host=/cloudsql/${INSTANCE_CONNECTION_NAME}"
log "Storing DATABASE_URL in Secret Manager"
if gcloud secrets describe "$DB_URL_SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  printf '%s' "$DB_URL_VALUE" | gcloud secrets versions add "$DB_URL_SECRET" \
    --data-file=- --project="$PROJECT_ID" >/dev/null
else
  printf '%s' "$DB_URL_VALUE" | gcloud secrets create "$DB_URL_SECRET" \
    --data-file=- --project="$PROJECT_ID" --replication-policy=automatic
fi

# ─── Build + push image via Cloud Build (no local Docker push needed) ──
IMAGE_URI="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
log "Building + pushing container image via Cloud Build → $IMAGE_URI"
gcloud builds submit "$API_DIR" \
  --tag="$IMAGE_URI" \
  --project="$PROJECT_ID"

# ─── Deploy Cloud Run service ──────────────────────────────────────────
log "Deploying Cloud Run service '$SERVICE_NAME'"
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE_URI" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --service-account="$SA_EMAIL" \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --set-env-vars="ENVIRONMENT=staging,APP_AUTH_AUDIENCE=seensnap-mobile,APPLE_BUNDLE_ID=com.seensnap.app" \
  --set-secrets="DATABASE_URL=${DB_URL_SECRET}:latest,APP_AUTH_SECRET=seensnap-app-auth-secret:latest,TMDB_API_KEY=seensnap-tmdb-key:latest,GOOGLE_OAUTH_CLIENT_ID=seensnap-google-oauth-client-id:latest" \
  --min-instances=0 \
  --max-instances=3 \
  --cpu=1 \
  --memory=512Mi \
  --port=8080 \
  --project="$PROJECT_ID"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
log "Service URL: $SERVICE_URL"

# ─── Health check ──────────────────────────────────────────────────────
log "Probing /health"
if curl -sfL "${SERVICE_URL}/health" | grep -q '"status":"ok"'; then
  echo "  /health OK"
else
  warn "/health did not return {status: ok} — check Cloud Run logs."
fi

# ─── Migrations via one-shot Cloud Run Job ─────────────────────────────
JOB_NAME="${SERVICE_NAME}-migrate"
log "Ensuring migration job '$JOB_NAME'"
if gcloud run jobs describe "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud run jobs update "$JOB_NAME" \
    --image="$IMAGE_URI" \
    --region="$REGION" \
    --service-account="$SA_EMAIL" \
    --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
    --set-env-vars="ENVIRONMENT=staging" \
    --set-secrets="DATABASE_URL=${DB_URL_SECRET}:latest,APP_AUTH_SECRET=seensnap-app-auth-secret:latest" \
    --command="alembic" --args="upgrade,head" \
    --project="$PROJECT_ID"
else
  gcloud run jobs create "$JOB_NAME" \
    --image="$IMAGE_URI" \
    --region="$REGION" \
    --service-account="$SA_EMAIL" \
    --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
    --set-env-vars="ENVIRONMENT=staging" \
    --set-secrets="DATABASE_URL=${DB_URL_SECRET}:latest,APP_AUTH_SECRET=seensnap-app-auth-secret:latest" \
    --command="alembic" --args="upgrade,head" \
    --project="$PROJECT_ID"
fi

log "Running migrations"
gcloud run jobs execute "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" --wait

# ─── Done ──────────────────────────────────────────────────────────────
cat <<EOF

✅  Staging deployment complete.

    Cloud Run URL:      $SERVICE_URL
    Cloud SQL instance: $INSTANCE_CONNECTION_NAME
    Region:             $REGION

Next steps
  1. Add this URL to your local .env so acceptance tests can hit staging:
       export SEENSNAP_API_URL="${SERVICE_URL}/api/v1"
     Then run: cd apps/api && .venv/bin/python -m scripts.team_acceptance

  2. Configure CORS after Netlify assigns a URL. Add this env var to the
     Cloud Run service:
       CORS_ALLOWED_ORIGINS=https://<your-site>.netlify.app
     Rerun: gcloud run services update $SERVICE_NAME --region=$REGION \\
              --update-env-vars=CORS_ALLOWED_ORIGINS=…

  3. Give Netlify the following EXPO_PUBLIC_* vars:
       EXPO_PUBLIC_API_BASE_URL=${SERVICE_URL}/api/v1
       EXPO_PUBLIC_ENVIRONMENT=staging
       EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<the same web client id you gave
                                          to seensnap-google-oauth-client-id>
EOF
