#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# Optional flag to skip forcing a frontend re-pin (used when deploy.sh deploys both)
SKIP_FRONTEND_SYNC="${SKIP_FRONTEND_SYNC:-false}"

echo "==> Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID

echo "==> Storing secrets in Secret Manager..."
echo -n "$OPENAI_API_KEY" | gcloud secrets create OPENAI_API_KEY \
  --data-file=- --project=$PROJECT_ID 2>/dev/null || \
echo -n "$OPENAI_API_KEY" | gcloud secrets versions add OPENAI_API_KEY \
  --data-file=- --project=$PROJECT_ID

if [ -z "$SERVICE_API_KEY" ]; then
  SERVICE_API_KEY=$(openssl rand -hex 32)
  echo "==> Generated SERVICE_API_KEY: $SERVICE_API_KEY"
fi
echo -n "$SERVICE_API_KEY" | gcloud secrets create SERVICE_API_KEY \
  --data-file=- --project=$PROJECT_ID 2>/dev/null || \
echo -n "$SERVICE_API_KEY" | gcloud secrets versions add SERVICE_API_KEY \
  --data-file=- --project=$PROJECT_ID

echo "==> Granting Cloud Run access to secrets..."
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for SECRET in OPENAI_API_KEY SERVICE_API_KEY; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor" \
    --project=$PROJECT_ID
done

echo "==> Building and pushing backend image..."
cd "$SCRIPT_DIR/backend/docsend_capture_service"
gcloud builds submit --tag $REPO/$BACKEND_SERVICE .
cd "$SCRIPT_DIR"

echo "==> Deploying backend to Cloud Run..."
gcloud run deploy $BACKEND_SERVICE \
  --image $REPO/$BACKEND_SERVICE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --set-secrets="OPENAI_API_KEY=OPENAI_API_KEY:latest,SERVICE_API_KEY=SERVICE_API_KEY:latest" \
  --set-env-vars="AG2_MODEL=gpt-4o-mini,CAPTURE_GATE_EMAIL=$CAPTURE_GATE_EMAIL" \
  --project=$PROJECT_ID

BACKEND_URL=$(gcloud run services describe $BACKEND_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)
echo "==> Backend deployed at: $BACKEND_URL"

# Re-pin the frontend to the latest secret version so it stays in sync with the backend.
# Skipped when deploy.sh is running both, since deploy-frontend.sh will do a full redeploy anyway.
if [ "$SKIP_FRONTEND_SYNC" != "true" ]; then
  echo "==> Re-pinning frontend to latest SERVICE_API_KEY..."
  FRONTEND_IMAGE=$(gcloud run services describe $FRONTEND_SERVICE \
    --region $REGION --format="value(spec.template.spec.template.spec.containers[0].image)" --project=$PROJECT_ID 2>/dev/null || echo "$REPO/$FRONTEND_SERVICE")
  gcloud run deploy $FRONTEND_SERVICE \
    --image $FRONTEND_IMAGE \
    --region $REGION \
    --platform managed \
    --update-secrets="SERVICE_API_KEY=SERVICE_API_KEY:latest" \
    --set-env-vars="BACKEND_URL=$BACKEND_URL" \
    --project=$PROJECT_ID
  echo "==> Frontend re-pinned."
fi
