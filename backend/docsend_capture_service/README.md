# Deck Viewer Capture Service

A FastAPI service that captures shared deck viewers (DocSend, PandaDoc, Papermark, and similar) using a Playwright browser agent. It screenshots each slide, auto-crops whitespace, and assembles a clean PDF sized to the slide dimensions.

AG2 is used optionally to plan browser navigation selectors (next-page, email gate, cookie banners). If `OPENAI_API_KEY` is not set, the service falls back to a built-in selector list.

---

## Architecture

```
Client
  │
  ├── POST /capture          → synchronous, returns full result when done
  └── POST /capture/stream   → SSE stream, emits progress events per page then final result
          │
          └── DocsendWebAgent (Playwright + AG2Planner)
                ├── Dismiss cookie banners
                ├── Submit email gates
                ├── Screenshot each slide
                ├── Auto-crop whitespace (PIL + numpy)
                └── Assemble PDF (ReportLab, page sized to slide)
```

---

## API Reference

### Authentication

All endpoints except `/health` require an `X-API-Key` header.

```
X-API-Key: <SERVICE_API_KEY>
```

The key is stored in GCP Secret Manager as `SERVICE_API_KEY` and injected into both the backend and frontend Cloud Run services at deploy time. Both services are always pinned to the same secret version.

---

### `GET /health`

Unauthenticated liveness check.

**Response**
```json
{ "status": "ok" }
```

---

### `POST /capture`

Synchronous capture. Blocks until all pages are captured and returns the full result.

**Request**
```json
{
  "url": "https://docsend.com/view/...",
  "max_pages": 20,
  "gate_email": "optional@email.com"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | ✅ | — | URL of the deck viewer |
| `max_pages` | integer | ❌ | 20 | Max slides to capture (1–100) |
| `gate_email` | string | ❌ | `CAPTURE_GATE_EMAIL` env var | Email to submit on gated viewers |

**Response**
```json
{
  "title": "Deck title from page",
  "page_count": 32,
  "screenshots": [
    { "page": 1, "data_url": "data:image/png;base64,..." },
    ...
  ],
  "pdf_base64": "<base64-encoded PDF>"
}
```

**Example**
```bash
curl -X POST https://<cloud-run-url>/capture \
  -H "X-API-Key: <SERVICE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.papermark.com/view/abc123", "max_pages": 50}'
```

---

### `POST /capture/stream`

Streaming capture via [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events). Emits a progress event for each page captured, then a final `done` event with the full result.

**Request** — same body as `/capture`

**SSE Events**

Each event is a `data:` line containing a JSON object.

| `event` | Payload | Description |
|---|---|---|
| `page` | `{ "event": "page", "page": 3 }` | Emitted after each page is captured |
| `done` | `{ "event": "done", "title": "...", "page_count": 32, "screenshots": [...], "pdf_base64": "..." }` | Emitted when capture is complete |
| `error` | `{ "event": "error", "detail": "..." }` | Emitted if capture fails |

**Example — curl**
```bash
curl -X POST https://<cloud-run-url>/capture/stream \
  -H "X-API-Key: <SERVICE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.papermark.com/view/abc123"}' \
  --no-buffer
```

**Example — Python**
```python
import requests, json

with requests.post(
    "https://<cloud-run-url>/capture/stream",
    json={"url": "https://docsend.com/view/abc123", "max_pages": 50},
    headers={"X-API-Key": "<SERVICE_API_KEY>"},
    stream=True,
    timeout=600,
) as resp:
    buf = ""
    for chunk in resp.iter_content(chunk_size=None):
        buf += chunk.decode("utf-8")
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            if not line.startswith("data: "):
                continue
            msg = json.loads(line[6:])
            if msg["event"] == "page":
                print(f"Captured page {msg['page']}")
            elif msg["event"] == "done":
                print(f"Done — {msg['page_count']} pages")
                pdf_b64 = msg["pdf_base64"]
            elif msg["event"] == "error":
                print(f"Error: {msg['detail']}")
```

**Example — JavaScript (browser / Node)**
```javascript
const resp = await fetch("https://<cloud-run-url>/capture/stream", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": "<SERVICE_API_KEY>",
  },
  body: JSON.stringify({ url: "https://docsend.com/view/abc123", max_pages: 50 }),
});

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop(); // keep incomplete line in buffer
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const msg = JSON.parse(line.slice(6));
    if (msg.event === "page") console.log(`Captured page ${msg.page}`);
    else if (msg.event === "done") console.log(`Done — ${msg.page_count} pages`);
    else if (msg.event === "error") console.error(msg.detail);
  }
}
```

---

## Environment Variables

Create `backend/docsend_capture_service/.env`:

```bash
OPENAI_API_KEY=<your-openai-key>
AG2_MODEL=gpt-4o-mini
NGROK_AUTHTOKEN=<your-ngrok-token>            # optional, for local tunneling
SERVICE_API_KEY=<your-service-api-key>        # auto-generated on first deploy if not set
CAPTURE_GATE_EMAIL=<email-for-viewer-gates>   # fallback email for gated viewers
```

---

## Run Locally

```bash
cd backend/docsend_capture_service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

---

## Deployment

### Deploy both services together

```bash
./deploy.sh
```

Deploys backend then frontend in sequence. The `SERVICE_API_KEY` secret is written once and both services are pinned to the same version.

### Deploy backend only

```bash
./deploy-backend.sh
```

Builds and deploys the backend. After deploying, automatically forces a new frontend revision to re-pin it to the latest `SERVICE_API_KEY` — keeping both services in sync even if the key was rotated.

### Deploy frontend only

```bash
./deploy-frontend.sh
```

Builds and deploys the frontend only. Reads the current backend URL from Cloud Run and uses `--update-secrets` for `SERVICE_API_KEY` to avoid type conflicts with the existing secret binding.

### What `deploy-backend.sh` does

1. Enables required GCP APIs
2. Pushes `OPENAI_API_KEY` and `SERVICE_API_KEY` to Secret Manager (generates `SERVICE_API_KEY` if not set in `.env`)
3. Grants the Cloud Run compute SA `secretmanager.secretAccessor` on both secrets
4. Builds and pushes the backend image via Cloud Build
5. Deploys backend to Cloud Run with secrets injected
6. Forces a frontend revision to re-pin `SERVICE_API_KEY:latest` (skipped when called from `deploy.sh`)

---

## Teardown

```bash
./undeploy.sh
```

Deletes both Cloud Run services, container images, IAM bindings, and Secret Manager secrets.

---

## CI/CD — GitHub Actions

Pushes to `main` that touch `backend/` automatically trigger a Cloud Run deployment via `.github/workflows/deploy.yml`.

### First-time setup

Requires [gh CLI](https://cli.github.com/) and `gcloud` authenticated.

```bash
brew install gh
gh auth login
./setup-github-secrets.sh
```

Creates a `github-actions-deployer` GCP service account with roles: Cloud Run Admin, Cloud Build Editor, Secret Manager Admin, Storage Admin. Downloads a JSON key as `GCP_SA_KEY` in GitHub secrets and bulk-loads all remaining secrets from `.env`.

### Teardown CI/CD

```bash
./teardown-github-secrets.sh
```

Removes IAM bindings, deletes the service account and all its keys, and deletes all GitHub secrets.

---

## Integration with Other Services

### Supabase Edge Function

Set in the Supabase function environment:

```bash
DOCSEND_CAPTURE_SERVICE_URL=https://<cloud-run-url>
DOCSEND_CAPTURE_SERVICE_API_KEY=<SERVICE_API_KEY>
```

Call `/capture` or `/capture/stream` from your edge function using the examples above.

### Any HTTP client

The service is a standard HTTP API. Any service that can make HTTP requests and handle SSE can integrate with it:

- Use `/capture` for simple fire-and-forget integrations where you just need the final PDF
- Use `/capture/stream` for integrations that need to show progress or process pages incrementally
- The `pdf_base64` field in the response is a standard base64-encoded PDF — decode and store or forward as needed
- The `screenshots` array contains per-page `data:image/png;base64,...` data URLs — useful for displaying individual slides or running per-page processing (OCR, vision models, etc.)
