#!/usr/bin/env bash
# One-time GCP setup + deploy for the image keyword job.
# Review the variables, then run step by step (or all at once) from the project root.
set -euo pipefail

PROJECT_ID="PROJECT_ID"
DEPLOY_ACCOUNT="ACCOUNT"  # runs this script (project Owner); never a search UI user
REGION="europe-north1"          # Cloud Run region
SCHEDULER_REGION="europe-west1" # Cloud Scheduler region (europe-north1 has no Scheduler; see `gcloud scheduler locations list`)
FIRESTORE_LOCATION="europe-north1"       # or a single region such as europe-north1
JOB_NAME="image-keywords"
SCHEDULE="*/15 * * * *"         # every 15 minutes
DROPBOX_ROOTS="/Camera Uploads"

# Existing LLM service (already deployed; see llm/Dockerfile for how to build one)
LLM_SERVICE="ollama-qwen"
LLM_REGION="europe-west1"       # must be a region with Cloud Run GPUs (europe-north1 has none)
LLM_URL="LLM_URL"
LLM_MODEL="qwen2.5vl:7b"        # must match the model baked into the service's image

WEB_SERVICE="image-keywords-web"  # search UI + API, behind IAP
WEB_USERS="user@example.com"  # Google accounts allowed to use the search UI (IAP access only, no project roles)

JOB_SA="${JOB_NAME}-runner@${PROJECT_ID}.iam.gserviceaccount.com"
WEB_SA="${WEB_SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="${JOB_NAME}-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

# Every gcloud call below runs as the deploy account in this project, whatever your active
# gcloud configuration is. Nothing in your global config is changed.
export CLOUDSDK_CORE_ACCOUNT="$DEPLOY_ACCOUNT"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

if ! gcloud auth list --format='value(account)' | grep -qx "$DEPLOY_ACCOUNT"; then
  echo "Not signed in as $DEPLOY_ACCOUNT. Run: gcloud auth login $DEPLOY_ACCOUNT" >&2
  exit 1
fi
if [[ ",${WEB_USERS}," == *",${DEPLOY_ACCOUNT},"* ]]; then
  echo "WEB_USERS must not include the deploy account ($DEPLOY_ACCOUNT)." >&2
  exit 1
fi

# 1. APIs
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com iap.googleapis.com

# 2. Firestore (Native mode). The free tier applies to the first database in a project.
gcloud firestore databases create --location="$FIRESTORE_LOCATION" --type=firestore-native || true

# 3. Composite indexes
#    a) worker queue: status == pending AND nextAttemptAt <= now ORDER BY nextAttemptAt
gcloud firestore indexes composite create --collection-group=images \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=nextAttemptAt,order=ascending || true
#    b) search: status == done AND searchTerms array-contains(-any) ...
gcloud firestore indexes composite create --collection-group=images \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=searchTerms,array-config=contains || true
#    c) search API, newest first: ... ORDER BY modifiedAt DESC
gcloud firestore indexes composite create --collection-group=images \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=searchTerms,array-config=contains \
  --field-config=field-path=modifiedAt,order=descending || true

# 4. Secrets (you'll be prompted to paste each value)
for s in dropbox-app-key dropbox-app-secret dropbox-refresh-token; do
  if ! gcloud secrets describe "$s" >/dev/null 2>&1; then
    read -rsp "Value for $s: " val; echo
    printf '%s' "$val" | gcloud secrets create "$s" --data-file=- --replication-policy=automatic
  fi
done

# 5. Service accounts
gcloud iam service-accounts create "${JOB_NAME}-runner" --display-name="Image keyword job" || true
gcloud iam service-accounts create "${JOB_NAME}-scheduler" --display-name="Image keyword scheduler" || true

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${JOB_SA}" --role="roles/datastore.user" --condition=None >/dev/null
for s in dropbox-app-key dropbox-app-secret dropbox-refresh-token; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${JOB_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null
done

# 6. Let the job call the existing (private) LLM service
gcloud run services add-iam-policy-binding "$LLM_SERVICE" --region "$LLM_REGION" \
  --member="serviceAccount:${JOB_SA}" --role="roles/run.invoker" >/dev/null

# 7. Build + deploy the Cloud Run Job (builds the Dockerfile with Cloud Build)
gcloud run jobs deploy "$JOB_NAME" \
  --source . \
  --region "$REGION" \
  --service-account "$JOB_SA" \
  --tasks 1 --max-retries 0 --task-timeout 25m \
  --memory 512Mi --cpu 1 \
  --set-env-vars "DROPBOX_ROOTS=${DROPBOX_ROOTS},GCP_PROJECT_ID=${PROJECT_ID},LLM_URL=${LLM_URL},LLM_MODEL=${LLM_MODEL},LLM_AUTH=google-id-token" \
  --set-secrets "DROPBOX_APP_KEY=dropbox-app-key:latest,DROPBOX_APP_SECRET=dropbox-app-secret:latest,DROPBOX_REFRESH_TOKEN=dropbox-refresh-token:latest"

# 8. Let the scheduler start the job, then schedule it
gcloud run jobs add-iam-policy-binding "$JOB_NAME" --region "$REGION" \
  --member="serviceAccount:${SCHEDULER_SA}" --role="roles/run.invoker" >/dev/null

gcloud scheduler jobs create http "${JOB_NAME}-schedule" \
  --location "$SCHEDULER_REGION" \
  --schedule "$SCHEDULE" \
  --uri "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run" \
  --http-method POST \
  --oauth-service-account-email "$SCHEDULER_SA" || \
gcloud scheduler jobs update http "${JOB_NAME}-schedule" \
  --location "$SCHEDULER_REGION" --schedule "$SCHEDULE"

# 9. Search UI + API: one Cloud Run service behind IAP, with read-only access to Firestore and Dropbox
gcloud iam service-accounts create "$WEB_SERVICE" --display-name="Image search UI + API" || true
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${WEB_SA}" --role="roles/datastore.viewer" --condition=None >/dev/null
for s in dropbox-app-key dropbox-app-secret dropbox-refresh-token; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${WEB_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null
done

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${WEB_SERVICE}"

# Same image as the job; the command runs the API, which also serves the built SPA.
gcloud run deploy "$WEB_SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$WEB_SA" \
  --command node --args dist/api/index.js \
  --no-allow-unauthenticated --iap \
  --memory 512Mi --cpu 1 --max-instances 2 \
  --set-env-vars "GCP_PROJECT_ID=${PROJECT_ID},API_AUTH=iap,IAP_AUDIENCE=${IAP_AUDIENCE}" \
  --set-secrets "DROPBOX_APP_KEY=dropbox-app-key:latest,DROPBOX_APP_SECRET=dropbox-app-secret:latest,DROPBOX_REFRESH_TOKEN=dropbox-refresh-token:latest"

# 10. IAP forwards requests to the service as its own service agent (needs: gcloud components install beta)
gcloud beta services identity create --service=iap.googleapis.com >/dev/null
gcloud run services add-iam-policy-binding "$WEB_SERVICE" --region "$REGION" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role="roles/run.invoker" >/dev/null

# 11. OAuth client for personal Google accounts.
#     IAP's default Google-managed client only admits users of your own organization, and doesn't
#     work at all in a project without one ("Empty Google Account OAuth client ID(s)/secret(s)"),
#     so IAP needs a custom client. gcloud can't create one, so that part is done in the console.
cat <<EOF

One-time manual step: create an OAuth client for IAP.
  1. Open https://console.cloud.google.com/auth/overview?project=${PROJECT_ID}
     and click "Get started" if asked (app name, support email, Audience: External).
  2. Google Auth Platform -> Audience: click "Publish app" so the status is "In production".
     (IAP only asks for email/profile, which don't need Google's app verification.)
  3. Google Auth Platform -> Clients -> Create client: type "Web application", any name.
     Create it, then copy the client ID and secret.
  4. Edit the client and add this authorized redirect URI (with your client ID):
       https://iap.googleapis.com/v1/oauth/clientIds/CLIENT_ID:handleRedirect
EOF
read -rp "OAuth client ID: " IAP_CLIENT_ID
read -rsp "OAuth client secret: " IAP_CLIENT_SECRET; echo

IAP_SETTINGS="$(mktemp)"
trap 'rm -f "$IAP_SETTINGS"' EXIT
cat > "$IAP_SETTINGS" <<EOF
access_settings:
  oauth_settings:
    client_id: ${IAP_CLIENT_ID}
    client_secret: ${IAP_CLIENT_SECRET}
EOF
gcloud iap settings set "$IAP_SETTINGS" --project="$PROJECT_ID" \
  --resource-type=cloud-run --service="$WEB_SERVICE" --region="$REGION" >/dev/null

# 12. Allowed users (see README "Managing users" to add or remove one later)
IFS=',' read -ra users <<< "$WEB_USERS"
for u in "${users[@]}"; do
  gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
    --service="$WEB_SERVICE" --region="$REGION" \
    --member="user:${u}" --role="roles/iap.httpsResourceAccessor" >/dev/null
done

WEB_URL="$(gcloud run services describe "$WEB_SERVICE" --region "$REGION" --format 'value(status.url)')"
echo "Done. Search UI: ${WEB_URL}"
echo "Run the job once now with: gcloud run jobs execute $JOB_NAME --region $REGION --wait"
