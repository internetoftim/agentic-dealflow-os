#!/bin/bash
set -euo pipefail

ENV_FILE="backend/docsend_capture_service/.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)
else
  echo "WARN: $ENV_FILE not found, using environment variables"
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: OPENAI_API_KEY not set"; exit 1
fi

PROJECT_ID="${PROJECT_ID:-api-project-845824049229}"
REGION="us-central1"
BACKEND_SERVICE="docsend-backend"
FRONTEND_SERVICE="docsend-frontend"
REPO="gcr.io/$PROJECT_ID"

echo "==> Using GCP project: $PROJECT_ID"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling required APIs (skipping if no permission)..."
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID 2>/dev/null || echo "WARN: Could not enable APIs (likely already enabled)"

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
cd backend/docsend_capture_service
gcloud builds submit --tag $REPO/$BACKEND_SERVICE .

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
  --set-env-vars="AG2_MODEL=gpt-4o-mini" \
  --project=$PROJECT_ID

BACKEND_URL=$(gcloud run services describe $BACKEND_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)
echo "==> Backend deployed at: $BACKEND_URL"

echo "==> Building and pushing frontend image..."
cd ../.. 
cat > /tmp/cloudbuild-frontend.yaml <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-t', '$REPO/$FRONTEND_SERVICE', '-f', 'Dockerfile.frontend', '.']
images: ['$REPO/$FRONTEND_SERVICE']
EOF
gcloud builds submit \
  --config /tmp/cloudbuild-frontend.yaml \
  backend/docsend_capture_service

echo "==> Deploying frontend to Cloud Run..."
gcloud run deploy $FRONTEND_SERVICE \
  --image $REPO/$FRONTEND_SERVICE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars="BACKEND_URL=$BACKEND_URL" \
  --project=$PROJECT_ID

FRONTEND_URL=$(gcloud run services describe $FRONTEND_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)
echo "==> Frontend deployed at: $FRONTEND_URL"
echo ""
echo "✅ Done! Open your app at: $FRONTEND_URL"
