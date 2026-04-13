#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

MCP_SERVICE="docsend-mcp"

echo "==> Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID

# Ensure SERVICE_API_KEY secret exists (backend deploy creates it; this is a safety net)
if ! gcloud secrets describe SERVICE_API_KEY --project=$PROJECT_ID &>/dev/null; then
  echo "ERROR: SERVICE_API_KEY secret not found. Run deploy-backend.sh first."
  exit 1
fi

echo "==> Granting Cloud Run access to SERVICE_API_KEY secret..."
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding SERVICE_API_KEY \
  --member="serviceAccount:$SA" \
  --role="roles/secretmanager.secretAccessor" \
  --project=$PROJECT_ID

echo "==> Resolving backend URL..."
BACKEND_URL=$(gcloud run services describe $BACKEND_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)
echo "    Backend: $BACKEND_URL"

echo "==> Building and pushing MCP server image..."
cd "$SCRIPT_DIR/backend/docsend_capture_service"
gcloud builds submit \
  --config cloudbuild.mcp.yaml \
  --substitutions="_IMAGE=$REPO/$MCP_SERVICE" \
  .
cd "$SCRIPT_DIR"

echo "==> Deploying MCP server to Cloud Run..."
gcloud run deploy $MCP_SERVICE \
  --image $REPO/$MCP_SERVICE \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 256Mi \
  --cpu 1 \
  --timeout 300 \
  --set-secrets="SERVICE_API_KEY=SERVICE_API_KEY:latest" \
  --set-env-vars="DOCSEND_API_URL=$BACKEND_URL,MCP_TRANSPORT=sse" \
  --project=$PROJECT_ID

MCP_URL=$(gcloud run services describe $MCP_SERVICE \
  --region $REGION --format="value(status.url)" --project=$PROJECT_ID)
echo ""
echo "✅ MCP server deployed at: $MCP_URL"
echo ""
echo "Add to your MCP client config:"
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"docsend-capture\": {"
echo "        \"url\": \"$MCP_URL/sse\""
echo "      }"
echo "    }"
echo "  }"
