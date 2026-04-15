# AGENTS.md

## Repo Overview

- Frontend app: Vite + React + TypeScript at the repo root.
- Supabase edge functions: `supabase/functions/**` using Deno.
- DocSend capture backend: FastAPI service in `backend/docsend_capture_service`.

## Setup

- Preferred Node.js version: 20+.
- Install frontend dependencies from the repo root:

```bash
npm ci
```

- Deno is required for work involving `supabase/functions/**`.
- Supabase CLI is helpful but optional unless a task requires serving or deploying edge functions locally.

## Primary Commands

Run these from the repo root unless a task explicitly targets the Python backend.

- Install dependencies:

```bash
npm ci
```

- Start frontend dev server:

```bash
npm run dev
```

- Build frontend:

```bash
npm run build
```

- Run frontend tests:

```bash
npm test
```

- Run frontend lint:

```bash
npm run lint
```

## Backend Commands

For the Cloud Run capture backend in `backend/docsend_capture_service`:

- Install Python dependencies:

```bash
cd backend/docsend_capture_service
pip install -r requirements.txt
```

- Run locally:

```bash
cd backend/docsend_capture_service
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Validation Guidance

- For frontend changes, prefer this sequence:

```bash
npm run build
npm test
npm run lint
```

- If dependencies are missing, run `npm ci` before retrying validation.
- If Deno is unavailable, note that Supabase function validation could not be completed.
- If required secrets are unavailable, do not invent values; state what could not be verified.

## Repo-Specific Guidance

- Keep the Cloud Run DocSend backend focused on capture/rendering only.
- Do not introduce a callback-based `/capture-async` flow unless the task explicitly requires a new backend contract.
- DocSend/PandaDoc/Papermark orchestration belongs in the Supabase layer, especially:
  - `supabase/functions/process-docsend`
  - `supabase/functions/run-docsend-capture`
- Preserve the separation of concerns:
  - Cloud Run backend: capture a viewer URL and return capture results.
  - Supabase/webapp: create deals, track jobs, upload storage artifacts, retry jobs, and hand off to `process-deck`.

## Environment Variables

Tasks involving Supabase functions or the capture flow may require:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DOCSEND_CAPTURE_SERVICE_URL`
- `DOCSEND_CAPTURE_SERVICE_API_KEY`
- `OPENAI_API_KEY`
- `FIRECRAWL_API_KEY`

## Notes For Codex Cloud

- If `npm run build` fails with `vite: command not found`, dependencies have not been installed yet.
- If `npm test` fails with `vitest: command not found`, dependencies have not been installed yet.
- Setup scripts in the remote environment should run `npm ci` before agent execution.
