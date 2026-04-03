# Deck Viewer Capture Service (FastAPI + AG2 + Web Agent)

This service captures shared deck viewers (DocSend, PandaDoc, Papermark, and similar web viewers) with a browser agent, screenshots each page, and assembles a clean PDF. The service intentionally focuses on visual capture only (no downstream information extraction).

## Endpoints

- `GET /health` — unauthenticated
- `POST /capture` — requires `X-API-Key` header
  - body:
    ```json
    {
      "url": "https://docsend.com/view/...",
      "max_pages": 20,
      "gate_email": "optional@email.com"
    }
    ```
  - example:
    ```bash
    curl -X POST https://<cloud-run-url>/capture \
      -H "X-API-Key: <SERVICE_API_KEY>" \
      -H "Content-Type: application/json" \
      -d '{"url": "https://www.papermark.com/view/cmmuepdvo0001lb04nhx5g7xf"}'
    ```

## Authentication

The `/capture` endpoint is protected by an API key passed via the `X-API-Key` header. The key is stored in GCP Secret Manager as `SERVICE_API_KEY` and injected into Cloud Run at deploy time.

## Environment Variables

Create `backend/docsend_capture_service/.env`:

```bash
OPENAI_API_KEY=<your-openai-key>
AG2_MODEL=gpt-4o-mini
NGROK_AUTHTOKEN=<your-ngrok-token>       # optional, for local tunneling
SERVICE_API_KEY=<your-service-api-key>   # generated automatically on first deploy if not set
CAPTURE_GATE_EMAIL=<email-used-for-viewer-gates>  # optional fallback for email-gated viewers
```

## Run locally

```bash
cd backend/docsend_capture_service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Deploy to Cloud Run

From the repo root:

```bash
./deploy.sh
```

This will:
1. Enable required GCP APIs
2. Store `OPENAI_API_KEY` and `SERVICE_API_KEY` in Secret Manager (generates `SERVICE_API_KEY` if not set)
3. Grant the Cloud Run compute SA access to both secrets
4. Build and push backend + frontend images via Cloud Build
5. Deploy both services to Cloud Run

## Teardown Cloud Run

```bash
./undeploy.sh
```

Deletes both Cloud Run services, container images, IAM bindings, and secrets.

## CI/CD — GitHub Actions

On every push to `main` that touches `backend/`, the workflow at `.github/workflows/deploy.yml` automatically builds and redeploys both services.

### First-time setup

Requires [gh CLI](https://cli.github.com/) and `gcloud` authenticated.

```bash
brew install gh
gh auth login
./setup-github-secrets.sh
```

This will:
1. Create a `github-actions-deployer` GCP service account with roles: Cloud Run Admin, Cloud Build Editor, Secret Manager Admin, Storage Admin
2. Download a JSON key and set it as `GCP_SA_KEY` in GitHub secrets
3. Bulk-load all remaining secrets from `.env` into GitHub secrets

### Teardown CI/CD

```bash
./teardown-github-secrets.sh
```

Removes IAM bindings, deletes the service account and all its keys, and deletes all GitHub secrets.

## Integration with Supabase Edge Function

Set in Supabase function environment:

- `DOCSEND_CAPTURE_SERVICE_URL=http://<host>:8080`
- `DOCSEND_CAPTURE_SERVICE_API_KEY=<SERVICE_API_KEY>`

When configured, `process-docsend` uses this service to generate a PDF for the EasyVC extraction flow.
