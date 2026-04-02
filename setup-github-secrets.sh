#!/bin/bash
# Bootstrap CI/CD: creates GCP service account and loads secrets into GitHub Actions.
# Requires: gcloud authenticated, gh CLI authenticated.
set -e

PROJECT_ID="api-project-845824049229"
SA_NAME="github-actions-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_FILE="/tmp/gha-sa-key.json"

echo "==> Creating service account..."
gcloud iam service-accounts create $SA_NAME \
  --display-name="GitHub Actions Deployer" \
  --project=$PROJECT_ID 2>/dev/null || echo "Service account already exists"

echo "==> Assigning roles..."
for ROLE in roles/run.admin roles/cloudbuild.builds.editor roles/secretmanager.admin roles/storage.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$ROLE" --quiet
done

echo "==> Creating key..."
gcloud iam service-accounts keys create $KEY_FILE \
  --iam-account=$SA_EMAIL --project=$PROJECT_ID

echo "==> Loading secrets into GitHub Actions..."
gh secret set GCP_SA_KEY < $KEY_FILE

# Load remaining secrets from .env if it exists
ENV_FILE="backend/docsend_capture_service/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    gh secret set "$key" --body "$value"
    echo "  Set secret: $key"
  done < "$ENV_FILE"
fi

rm -f $KEY_FILE
echo "✅ Done. GitHub Actions secrets are set."
