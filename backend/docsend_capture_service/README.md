# DocSend Capture Service (FastAPI + AG2 + Web Agent)

This service captures DocSend/PandaDoc pages with a browser agent, screenshots each page, assembles them into a PDF, and returns both markdown + PDF payload.

## Endpoints

- `GET /health`
- `POST /capture`
  - body:
    ```json
    {
      "url": "https://docsend.com/view/...",
      "max_pages": 20
    }
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

## Integration with Supabase Edge Function

Set in Supabase function environment:

- `DOCSEND_CAPTURE_SERVICE_URL=http://<host>:8080`

When configured, `process-docsend` tries this service first before OpenAI computer-use / Firecrawl fallbacks.
