#!/bin/bash
set -e

PROJECT_ID="api-project-845824049229"
SA_NAME="github-actions-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Deleting service account keys..."
gcloud iam service-accounts keys list --iam-account=$SA_EMAIL --project=$PROJECT_ID \
  --format="value(name)" | xargs -I{} gcloud iam service-accounts keys delete {} \
  --iam-account=$SA_EMAIL --project=$PROJECT_ID --quiet 2>/dev/null || true

echo "==> Deleting service account..."
gcloud iam service-accounts delete $SA_EMAIL --project=$PROJECT_ID --quiet 2>/dev/null || true

echo "==> Deleting GitHub Actions secrets..."
for SECRET in GCP_SA_KEY OPENAI_API_KEY SERVICE_API_KEY AG2_MODEL; do
  gh secret delete $SECRET 2>/dev/null && echo "  Deleted: $SECRET" || true
done

echo "✅ Done."
