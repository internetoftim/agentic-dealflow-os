# EasyVC as an agent-native connector

The same MCP server serves Claude, ChatGPT, and any MCP client. It exposes the
whole product as tools **and** ships the workflows as prompts, so an agent can
run the deal inbox end to end: scan → confirm → ingest → research → report.

Endpoint: `https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/mcp-server`
Auth: OAuth 2.1 (dynamic client registration, PKCE) or a Personal Access Token
from EasyVC → Settings → AI Agents. Write tools require **Agent Mode** (same page).

### How discovery works (and why the issuer is the app domain)
The MCP endpoint answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`, whose
protected-resource document names `https://www.onepointsix.ai` as the authorization server.
Clients then read `https://www.onepointsix.ai/.well-known/oauth-authorization-server`
(a static file in `public/.well-known/`, mirrored by the function's own `/.well-known/…`),
which points `authorize` at the in-app consent page and `token` / `register` at the function.
The issuer cannot be the Supabase origin: its gateway owns `/.well-known/*` and `/register`
at the root and answers 401/404, which made Claude and Codex fall back to
`https://<supabase>/register` and fail with "Dynamic Client Registration rejected (HTTP 404)".
Keep the static file and `handleOAuthMetadata()` in `supabase/functions/mcp-server/index.ts` in sync.

## Agent-native sign-in
The identity a user signs in with is decoupled from Google. The consent page (`/mcp/authorize`)
is the primary entry point: an agent sends the user there, they sign in on the spot, approve, and
are returned to the agent. `/login` leads with the same options and keeps Google as the fallback
that is only *required* for Drive export and Gmail ingestion (connect it later from Settings).

**Sign in with ChatGPT** (Codex / OpenAI accounts) — implemented in `supabase/functions/siwc-auth`
as a standard OIDC code + PKCE flow against `https://auth.openai.com`, bridged into a Supabase
session with an admin magic-link token redeemed at `/auth/callback`. It switches itself on once
these secrets exist on the Supabase project:

| Secret | Value |
|---|---|
| `OPENAI_SIWC_CLIENT_ID` | the `oaiapp_…` id OpenAI issues |
| `OPENAI_SIWC_CLIENT_SECRET` | only for confidential clients; omit for public |
| `APP_ORIGIN` | `https://www.onepointsix.ai` (default if unset) |

Register this exact callback with OpenAI:
`https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/siwc-auth/callback`.
OpenAI currently issues client ids through a limited partner trial; request one via the
[Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)
(docs: https://developers.openai.com/siwc/quickstart). Until the id is set, `GET /siwc-auth/status`
returns `{enabled:false}` and the ChatGPT button is hidden.

**Sign in with Claude** is not offered: Anthropic's consumer terms prohibit using Claude account
OAuth in third-party products, and there is no public Claude identity provider. Claude users sign
in on the consent page with ChatGPT or Google, then work from Claude.

Accounts created this way go through the same invite-only approval queue as Google sign-ups.

## Claude (claude.ai / Claude Code / Cowork)
1. claude.ai → Settings → Connectors → *Add custom connector* → name "EasyVC", paste the endpoint,
   leave client id/secret empty (dynamic registration) → *Add* → *Connect* → approve on the EasyVC consent page.
   Claude Code: `claude mcp add --transport http easyvc https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/mcp-server`
   then `/mcp` → easyvc → Authenticate (this repo's `.mcp.json` already registers it).
2. Install the skill: copy `skills/deal-inbox-triage/` to `~/.claude/skills/` (Claude Code) or add it as a
   Cowork skill. Then say "triage the deal inbox".
3. Cowork schedule (suggested): weekday 08:30 — *"Run /deal-inbox-triage for the last 7 days and post the report."*
   The server also exposes the `deal_inbox_triage` and `weekly_pipeline_digest` prompts, so even without the
   skill a Claude client can pick the workflow from the prompt menu.

## Codex
- Codex app / ChatGPT → Settings → Connectors (or Codex → MCP servers) → *Add* → URL = the endpoint,
  auth = OAuth → sign in on the EasyVC consent page.
- Codex CLI: `codex mcp add easyvc --url https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/mcp-server`
  then `codex mcp login easyvc`. Or with a PAT: `codex mcp add easyvc --url <endpoint> --bearer-token-env-var EASYVC_TOKEN`.

## ChatGPT
Settings → Connectors → *Create* → MCP server URL = the endpoint, authentication OAuth. The server
implements the `search` / `fetch` pair ChatGPT requires for deep-research connectors, plus every
EasyVC tool for use in chat with Developer Mode. Try: *"Use EasyVC to scan the deal inbox and tell me
what's new"* — the model calls `scan_deal_inbox`, shows candidates, then `ingest_inbox_messages` on approval.

## Pairing with the Tavily connector
Add Tavily's MCP server next to EasyVC's and agents get raw web search for verification and
founder diligence, alongside EasyVC's structured deal tools:
- Claude Code / Cowork: this repo ships `.mcp.json` with both servers; export `TAVILY_API_KEY`
  in your shell and Claude Code substitutes it (the key is never committed). Or at user scope:
  `claude mcp add --scope user --transport http tavily "https://mcp.tavily.com/mcp/?tavilyApiKey=<key>"`.
- claude.ai / ChatGPT: add `https://mcp.tavily.com/mcp/?tavilyApiKey=<key>` as a custom connector.
The `deal-inbox-triage` skill tells the agent when to reach for `tavily_search` / `tavily_extract`
(claim verification, founder checks, back-filling thin research into the deal).

## The agent-native contract
| Step | Tool | Mutates? |
|---|---|---|
| Find (read state ignored, threads searched message-by-message) | `scan_deal_inbox` | no |
| Select by real Gmail message/attachment ids | `ingest_inbox_messages` | yes, idempotent |
| Everything the scheduler would do, now | `run_inbox_sweep` | yes |
| Report uploaded / attached / duplicate / unsupported / skipped / failed | `get_ingest_report` | no |
| Onboard a mailbox someone else controls | `create_receiver_invite` | yes |
| Take over once it's in: research, memo, notes, sharing | `run_deep_research`, `generate_memo`, … | yes |

Every ingestion — label, receiver inbox, public intake, agent — writes the same `ingest_events`
ledger, which is what Settings → Deal Inbox → *Recent activity* shows. Decks become deals; supporting
documents (xlsx/docx/csv/txt/md) attach to the deal as data-room sources with text extracted for
chat grounding; duplicates are caught by SHA-256 of the file.
