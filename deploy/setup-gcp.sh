#!/usr/bin/env bash
# One-time GCP setup + deploy for the image keyword job.
# Review the variables, then run step by step (or all at once) from the project root.
set -euo pipefail

PROJECT_ID="my-gcp-project"
REGION="europe-north1"          # Cloud Run + Scheduler region
FIRESTORE_LOCATION="eur3"       # or a single region such as europe-north1
JOB_NAME="image-keywords"
SCHEDULE="*/15 * * * *"         # every 15 minutes
DROPBOX_ROOTS="/Photos"

LLM_SERVICE="ollama"
LLM_REGION="europe-west1"       # must be a region with Cloud Run GPUs (europe-north1 has none)
LLM_MODEL="gemma3:4b"           # vision-capable model; keep in sync with ARG MODEL in llm/Dockerfile

JOB_SA="${JOB_NAME}-runner@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="${JOB_NAME}-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"

# 1. APIs
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com

# 2. Firestore (Native mode). The free tier applies to the first database in a project.
gcloud firestore databases create --location="$FIRESTORE_LOCATION" --type=firestore-native || true

# 3. Composite indexes
#    a) worker queue: status == pending AND nextAttemptAt <= now ORDER BY nextAttemptAt
gcloud firestore indexes composite create --collection-group=images \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=nextAttemptAt,order=ascending || true
#    b) future search: status == done AND searchTerms array-contains(-any) ...
gcloud firestore indexes composite create --collection-group=images \
  --field-config=field-path=status,order=ascending \
  --field-config=field-path=searchTerms,array-config=contains || true

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

# 6. Build + deploy the LLM as a private Cloud Run service with a GPU.
#    Needs Cloud Run GPU quota in $LLM_REGION (request it in the console if the deploy fails).
#    It scales to zero when idle; the first request after that waits for a cold start.
gcloud run deploy "$LLM_SERVICE" \
  --source llm \
  --region "$LLM_REGION" \
  --no-allow-unauthenticated \
  --gpu 1 --gpu-type nvidia-l4 --no-gpu-zonal-redundancy \
  --cpu 8 --memory 32Gi --no-cpu-throttling \
  --concurrency 4 --max-instances 1 --timeout 600
LLM_URL="$(gcloud run services describe "$LLM_SERVICE" --region "$LLM_REGION" --format 'value(status.url)')"

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
  --location "$REGION" \
  --schedule "$SCHEDULE" \
  --uri "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run" \
  --http-method POST \
  --oauth-service-account-email "$SCHEDULER_SA" || \
gcloud scheduler jobs update http "${JOB_NAME}-schedule" \
  --location "$REGION" --schedule "$SCHEDULE"

echo "Done. Run once now with: gcloud run jobs execute $JOB_NAME --region $REGION --wait"
