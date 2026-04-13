#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

BACKEND_URL=$(gcloud run services describe $BACKEND_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)

echo "==> Building and pushing frontend image..."
cat > /tmp/cloudbuild-frontend.yaml <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-t', '$REPO/$FRONTEND_SERVICE', '-f', 'Dockerfile.frontend', '.']
images: ['$REPO/$FRONTEND_SERVICE']
EOF
gcloud builds submit \
  --config /tmp/cloudbuild-frontend.yaml \
  "$SCRIPT_DIR/backend/docsend_capture_service"

echo "==> Deploying frontend to Cloud Run..."
gcloud run deploy $FRONTEND_SERVICE \
  --image $REPO/$FRONTEND_SERVICE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --set-env-vars="BACKEND_URL=$BACKEND_URL" \
  --update-secrets="SERVICE_API_KEY=SERVICE_API_KEY:latest" \
  --project=$PROJECT_ID

FRONTEND_URL=$(gcloud run services describe $FRONTEND_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)
echo "✅ Frontend deployed at: $FRONTEND_URL"
