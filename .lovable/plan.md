# Make EasyVC discoverable to AI agents + expose services via MCP

Two tracks: (1) **passive discoverability** so crawlers/LLMs understand the app, (2) **active tool access** so AI agents can call EasyVC capabilities through MCP.

---

## Track 1 — AI Discoverability (passive)

Goal: when ChatGPT, Claude, Perplexity, or an indexing crawler hits onepointsix.ai, they get a clean, structured description of what EasyVC does and how to use it.

### 1.1 `/llms.txt`
Add `public/llms.txt` (spec: llmstxt.org) with:
- H1: `EasyVC`
- Blockquote: one-line summary ("Autonomous OS for VC analysts — ingest deal flow, standardize in a workspace, draft investment memos.")
- Free-form paragraph on positioning + stack
- `## Pages` — only public surfaces: `/` (workspace overview), `/intake` (public submission portal), `/login`
- `## API` — link to the MCP endpoint (Track 2) and the public intake endpoint
- `## Optional` — pricing/about if/when those exist

Exclude every authenticated route (`/pipeline`, `/data-room`, `/settings`, `/deal/:id`, admin functions).

### 1.2 SEO / metadata polish in `index.html`
- Tighten `<title>` to keyword-bearing (<60 chars): "EasyVC — Autonomous OS for VC Analysts"
- Add canonical link (`https://onepointsix.ai/`)
- Add JSON-LD `SoftwareApplication` schema (name, description, url, applicationCategory: BusinessApplication)
- Add JSON-LD `Organization` schema
- Keep existing OG/Twitter tags

### 1.3 `robots.txt`
- Explicitly allow `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `anthropic-ai`, `PerplexityBot`, `Google-Extended`
- Add `Sitemap:` line
- Block authenticated paths (`/settings`, `/pipeline`, `/data-room`)

### 1.4 `sitemap.xml`
Static `public/sitemap.xml` listing only public URLs (`/`, `/intake`, `/login`).

### 1.5 `.well-known/ai-plugin.json` (optional, lightweight)
Legacy ChatGPT plugin manifest — cheap to add, points to the MCP server. Helps some discovery tools.

---

## Track 2 — Expose EasyVC as an MCP Server (active)

Goal: any MCP-capable agent (Claude Desktop, Cursor, ChatGPT, custom AI SDK app) can connect to EasyVC and call its core capabilities on behalf of a user.

### 2.1 Architecture
New Supabase edge function `mcp-server` using **mcp-lite** (latest, ≥0.10.0) over Streamable HTTP, mounted at:

```
https://<project>.supabase.co/functions/v1/mcp-server
```

Authentication: per-user via Supabase JWT in `Authorization: Bearer <token>`. Each tool call resolves `auth.uid()` and scopes all DB/storage access to that user (matches existing RLS).

For agents that can't easily pass a Supabase JWT, add a **personal access token** flow:
- New table `mcp_access_tokens` (id, user_id, token_hash, name, last_used_at, created_at, revoked_at) with RLS
- Settings → "MCP Access" panel to generate/revoke tokens
- mcp-server accepts `Bearer pat_xxx` and resolves to user_id

### 2.2 Tools to expose (v1)
Mirror what the in-app agent already does, read-heavy first:

**Read**
- `list_deals(stage?, status?, sector?, limit?)` → deals belonging to caller
- `get_deal(deal_id)` → full deal + sources + people
- `search_deals(query)` → uses existing hybrid search
- `get_deal_chat_context(deal_id)` → extracted text from sources (capped)

**Write / actions**
- `ingest_deal_from_url(url, notes?)` → wraps `ingest-relay` / `process-docsend`
- `ingest_deal_from_text(company_name, description, ...)` → manual create
- `run_deep_research(deal_id)` → triggers `deep-research`
- `generate_memo(deal_id)` → triggers `generate-memo`, returns Drive link
- `update_deal_status(deal_id, status)` → kanban move

All write tools persist via service-role client but **always** filter by resolved user_id.

### 2.3 Discovery surface for the MCP server
- Add MCP URL to `/llms.txt` API section
- Add a `/settings` → "Connect to AI Agents" section with copy-paste config snippets for Claude Desktop, Cursor, and the AI SDK MCP client (see `ai-sdk-mcp-client` knowledge)
- Public docs page `/docs/mcp` (unauthenticated) describing the server, tool list, and auth flow

### 2.4 OAuth (phase 2, optional)
For polished UX (no manual token paste), add OAuth 2.1 with dynamic client registration on the MCP server so Claude/ChatGPT can do one-click connect. Defer unless needed — PAT flow ships faster.

---

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| 1 | Track 1 entirely (llms.txt, SEO, robots, sitemap) | Small |
| 2 | MCP server skeleton + PAT auth + 4 read tools | Medium |
| 3 | Write tools (ingest, research, memo) + Settings UI | Medium |
| 4 | OAuth 2.1 dynamic client reg | Larger, optional |

## Technical notes

- mcp-lite + Hono in a Supabase edge function (per `mcp-server-supabase-edge-functions` knowledge); set Accept header `application/json, text/event-stream` for any outbound MCP calls
- Reuse existing edge functions internally — MCP tool handlers should `fetch` `process-docsend`, `deep-research`, `generate-memo` with the resolved user's JWT to keep one code path
- Rate-limit per token in the MCP handler (simple in-memory or `mcp_access_tokens.last_used_at` window)
- Never expose service-role key; PAT verification uses `crypto.subtle` SHA-256 against `token_hash`

## Questions before building
1. Should v1 ship **read-only** tools first (safer for external agents), or include write/ingest from day one?
2. PAT auth only, or also OAuth 2.1 in v1?
3. Should the public `/docs/mcp` page live in-app (React route) or as a static markdown page?
