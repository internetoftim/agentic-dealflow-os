# Product Requirements Document — EasyVC (agentic-dealflow-os)

> Reverse-engineered from the codebase at commit `f1c7004`. This document describes
> the product a team would have specced to produce this web app. It is descriptive
> of what exists, with intended behavior called out where the code reveals it.

---

## 1. Overview

**EasyVC** (branded "OnePointSix" / onepointsix.ai) is an **agentic dealflow operating
system for venture investors** — solo angels, scouts, and small VC funds. It turns the
messy top of the funnel (pitch decks arriving by email, DocSend link, or founder
submission) into a structured, AI-enriched pipeline: every deck is ingested, its text and
metrics extracted, the company researched across the web, an investment memo drafted, and
the whole thing filed to Google Drive — with a chat interface over each deal and an MCP
endpoint so external AI agents (Claude, Cursor, ChatGPT) can query the workspace.

The one-liner: **"Forward a deck, get a memo."**

### Goals
- Collapse the manual work between "a deck lands" and "I have a filed, researched memo."
- Meet decks wherever they arrive: manual upload, DocSend/Papermark/PandaDoc links, a public founder-facing intake form, and the investor's own Gmail inbox.
- Keep every investor's dealflow strictly private (multi-tenant isolation) while allowing per-deal sharing with collaborators.
- Expose the workspace to AI agents through a standard MCP server.

### Non-goals
- Portfolio management / cap-table / LP reporting.
- Sending email on the investor's behalf (Gmail is read + label only).
- A CRM. Deals are the only first-class object; there is no separate contacts/company graph.

---

## 2. Users & roles

| Persona | Description | Primary surface |
|---|---|---|
| **Investor (primary user)** | Angel/scout/VC who owns a workspace. Signs in with Google. | Deal Workspace, Pipeline, Settings |
| **Founder (unauthenticated)** | Submits a deck to a specific investor via a public link. | `/intake/:userId` public form |
| **Collaborator (shared)** | Someone the investor shares a single deal with via a link. | `/share/:token` → read the deal + chat |
| **AI agent (machine)** | Claude Desktop / Cursor / ChatGPT connecting over MCP with a PAT or OAuth. | `/functions/v1/mcp-server` |
| **Admin (latent)** | `user_roles` + approval workflow exist for invite-only gating. | Not yet enforced (see §9) |

Access is **invite-only by intent**: the login screen states new sign-ups require admin
approval, and the schema has an `approval_status` workflow. (Enforcement is currently a
gap — see Known Issues.)

---

## 3. Functional requirements

### FR-1 Authentication
- Google OAuth via Supabase Auth, requesting Drive (`drive.file`) and Gmail
  (`gmail.modify`, `gmail.readonly`) scopes with `access_type=offline` + `prompt=consent`
  so a refresh token is captured.
- Works both in a normal browser (redirect flow) and inside the Lovable preview iframe
  (popup + `skipBrowserRedirect`, polling for popup close).
- On login, the Google provider token + refresh token are persisted for later Gmail/Drive
  API calls. Protected routes redirect unauthenticated users to `/login`.

### FR-2 Deal ingestion (multiple channels)
1. **Manual upload** — drag/drop a PDF or PPTX. PDFs are re-serialized/compressed
   client-side via `pdf-lib`; PPTX passes through for server-side conversion. Only one
   active processing job at a time per user; additional uploads are `queued`.
2. **DocSend / Papermark / PandaDoc capture** — two paths:
   - **Bookmarklet** (client capture): runs on the viewer page, screenshots each slide off
     the `<canvas>`, opens a relay tab (`/ingest-relay`), and streams the images in via
     `postMessage` (to bypass the viewer's CSP).
   - **Server capture**: a Python headless-browser service (`docsend_capture_service`)
     drives the deck with an optional AG2/LLM planner to click through gated viewers, and
     returns page screenshots + a stitched PDF via a callback.
3. **Public intake form** (`/intake/:userId`) — a founder submits company name, contact,
   referral source, an optional deck file, and optional DocSend/LinkedIn/website links.
   Posts to the `public-intake` edge function.
4. **Gmail auto-ingest** — a Gmail watch + webhook + listener detect inbound decks in the
   investor's inbox and feed them into the same pipeline; a label marks processed threads.

### FR-3 Processing pipeline
Each deal advances through an ordered, observable workflow (`WORKFLOW_STEPS`):
`uploading → converting → compressing → scraping → extracting → searching-website →
syncing → deep-research → memo-ready`. Requirements:
- **Text extraction** with a choice of model (per `user_settings.ai_model`): a hosted model
  (default `gpt-oss-202b` via the Apollo inference bridge) or **local, in-browser vision**
  (Gemma 3n E2B via MediaPipe + WebGPU) that OCRs rendered PDF pages without the deck ever
  leaving the device.
- **Metric extraction** into structured deal fields: ask amount, valuation, revenue,
  growth, NRR, team size, sector, stage.
- **Deep research** — enrich with website, LinkedIn, Crunchbase, funding history,
  employee count, notable investors, recent articles, and a per-field
  research-verification list.
- **Memo generation** — draft an investment memo (`memo_draft`) and, when Drive is
  connected, write it to a Google Doc (`gdrive_file_id`).
- Progress must be **live**: the UI subscribes to Postgres realtime and also polls every 3s
  while any deal is processing (realtime is treated as best-effort).

### FR-4 Deal Workspace (`/`)
- Master/detail: a deal list + a detailed view of the selected deal.
- Streaming **chat over the deal** (`deal-chat` SSE) grounded in the extracted deck
  content and metrics. Conversation resets when switching deals.
- Panels for extracted metrics, investor research, latest articles, deck preview
  (traction/ask/team slides), and a Data Room.
- Deck download (owner only) from the private `decks` bucket.

### FR-5 Pipeline (`/pipeline`)
- Kanban board of deals by stage with per-card workflow progress and cancel.

### FR-6 Deal sharing
- Owner generates a high-entropy share link (`/share/:token`). Recipients sign in and
  auto-accept, gaining read access to that single deal (deal + sources + chat). Owner sees
  an access list and can revoke a link or an individual's access. Intended permission tier
  is `view_chat`.

### FR-7 MCP server (agent access)
- An MCP endpoint exposes read-only tools over the workspace (list/search deals, retrieve
  sources and extracted content, key people). Two auth modes:
  - **Personal Access Tokens** — generated in Settings, shown once, stored only as a
    SHA-256 hash (`mcp_access_tokens`).
  - **OAuth 2.0 + PKCE** — a full authorize/approve/token flow (`/mcp/authorize`,
    `mcp_oauth_clients/codes/tokens`) for one-click clients (Claude, ChatGPT).
- Access is read-only: no writes, deletes, or settings changes.

### FR-8 Settings (`/settings`)
- AI model preference (hosted vs local-vision).
- Public intake slug management.
- Gmail auto-ingest label toggle.
- MCP token management (FR-7).
- Storage cleanup utilities.

---

## 4. Data model (Postgres / Supabase)

Core tables (all with RLS scoped to `auth.uid() = user_id` unless noted):

- **`deals`** — the central object: identity, `stage`, `sector`, `source`,
  `status`/`deep_research_status`, deck sizes + `pages`, extracted metrics (ask, valuation,
  revenue, growth, nrr, team_size), research JSON (investors, articles, verification, deck
  preview), `memo_draft`, `gdrive_file_id`.
- **`sources`** — per-deal uploaded/captured artifacts: file name, storage path, sizes,
  `processing_status`, `extracted_text`.
- **`capture_jobs`** — DocSend/viewer capture jobs (url, status, error) for polling.
- **`deal_people`** — key people extracted from a deal.
- **`user_settings`** — model preference, intake slug, Gmail label flag, Google provider +
  refresh tokens, Gmail `historyId`.
- **`deal_shares` / `deal_share_access`** — share links and accepted recipients; access
  mediated by a `SECURITY DEFINER can_access_deal()` helper.
- **`profiles` / `user_roles`** — identity + role/approval workflow.
- **`mcp_access_tokens` / `mcp_oauth_clients` / `mcp_oauth_codes` / `mcp_oauth_tokens`** —
  MCP auth (OAuth tables are service-role only).

Storage: a private **`decks`** bucket, RLS-scoped to `{user_id}/…` folders.

---

## 5. Architecture

- **Frontend:** Vite + React 18 + TypeScript, shadcn-ui (Radix) + Tailwind, TanStack Query
  for server state, React Router. Deployed via Lovable.
- **Backend-as-a-service:** Supabase — Postgres + RLS, Auth (Google OAuth), Storage, and
  **Deno edge functions** for all server logic (`process-deck`, `deep-research`,
  `generate-memo`, `deal-chat`, `public-intake`, `ingest-relay`, `sync-to-drive`, the
  Gmail suite, and `mcp-server`).
- **Capture microservice:** a Python **FastAPI + Playwright/Chromium** service on Cloud Run
  (`backend/docsend_capture_service`) with an AG2/autogen LLM planner to navigate gated
  deck viewers; also exposes an MCP server and a Streamlit-style debug frontend.
- **AI:** hosted inference via the Apollo bridge (`gpt-oss-202b`) with web-search tool use
  for research; optional **fully local** vision (Gemma 3n E2B via MediaPipe + WebGPU) in
  the browser. Client PDF handling via `pdf-lib` + `pdfjs-dist`. Memos rendered with
  `react-markdown`.
- **Integrations:** Google Drive (memo filing) and Gmail (watch/read/label) via the OAuth
  provider token.

Routes: `/login`, `/intake/:userId` (public), `/share/:token`, `/mcp/authorize`,
`/ingest-relay`; and behind auth: `/` (Deal Workspace), `/pipeline`, `/data-room`,
`/intake`, `/settings`.

---

## 6. Non-functional requirements

- **Multi-tenant isolation:** every user's dealflow is private, enforced at the database
  layer by RLS (not just in the app).
- **Privacy option:** a local-only extraction path so sensitive decks need never leave the
  browser.
- **Responsiveness:** processing is asynchronous and fire-and-forget; the UI reflects live
  status via realtime + polling.
- **Least privilege for agents:** MCP access is read-only and token-scoped; PATs stored
  hashed.
- **Draft-not-send:** the product reads and organizes; it does not send email on the user's
  behalf.

---

## 7. Key user flows

1. **Forward-a-deck → memo:** deck arrives (email/upload/DocSend/intake) → pipeline extracts
   text + metrics → deep research → memo drafted → filed to Drive → investor reviews and
   chats with the deal.
2. **Founder submission:** founder opens the investor's public intake link → uploads deck +
   context → deal appears in the investor's inbox stage.
3. **Share a deal:** investor generates a share link → collaborator signs in, auto-accepts →
   reads the deal and its chat.
4. **Connect an agent:** investor creates a PAT (or OAuth-connects Claude) → the agent lists
   and searches deals and retrieves extracted content over MCP.

---

## 8. Success metrics (implied)

- Time from deck-arrival to memo-ready.
- % of decks auto-processed without manual intervention (esp. Gmail + intake channels).
- Extraction/research accuracy (the per-field `research_verification` list exists to track
  this).
- Agent adoption (active MCP tokens / calls).

---

## 9. Known gaps & risks (see `CODE_REVIEW.md` for detail)

- **Auth/authorization on server endpoints** is the weak point: several edge functions run
  with `verify_jwt = false` and trust body-supplied identifiers. The most serious is an
  unauthenticated cross-tenant write in `ingest-relay`; `sync-to-drive` and `process-deck`
  lack deal-ownership checks; `gmail-webhook` doesn't verify Pub/Sub signatures.
- **Capture service SSRF:** it renders any user-supplied URL server-side with no host
  allowlist.
- **Invite-only approval is not enforced** — the workflow exists in the schema but no code
  path calls it.
- **DocSend public-intake submissions are routed to the wrong function** and silently
  dropped.
- Assorted lower-severity issues: an open redirect on MCP "Deny," owner-email disclosure via
  the share-token RPC, and cross-origin `postMessage` trust in the ingest relay (which needs
  a nonce handshake, not a same-origin check, because the bookmarklet is cross-origin by
  design).

RLS tenant isolation itself was reviewed and found correct, and the markdown path is not an
XSS vector.
