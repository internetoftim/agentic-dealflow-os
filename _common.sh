#!/bin/bash
ENV_FILE="backend/docsend_capture_service/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
else
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

PROJECT_ID="api-project-845824049229"
REGION="us-central1"
BACKEND_SERVICE="docsend-backend"
FRONTEND_SERVICE="docsend-frontend"
REPO="gcr.io/$PROJECT_ID"

export PATH="$PATH:/Users/tims/google-cloud-sdk/bin"
