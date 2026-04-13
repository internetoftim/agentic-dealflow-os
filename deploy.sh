#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Deploying backend..."
SKIP_FRONTEND_SYNC=true bash "$SCRIPT_DIR/deploy-backend.sh"

echo "==> Deploying frontend..."
bash "$SCRIPT_DIR/deploy-frontend.sh"

FRONTEND_URL=$(source "$SCRIPT_DIR/_common.sh" && \
  gcloud run services describe $FRONTEND_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)
echo ""
echo "✅ Done! Open your app at: $FRONTEND_URL"
