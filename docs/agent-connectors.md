# EasyVC as an agent-native connector

The same MCP server serves Claude, ChatGPT, and any MCP client. It exposes the
whole product as tools **and** ships the workflows as prompts, so an agent can
run the deal inbox end to end: scan → confirm → ingest → research → report.

Endpoint: `https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/mcp-server`
Auth: OAuth 2.1 (dynamic client registration, PKCE) or a Personal Access Token
from EasyVC → Settings → AI Agents. Write tools require **Agent Mode** (same page).

## Claude (claude.ai / Claude Code / Cowork)
1. Settings → Connectors → *Add custom connector* → paste the endpoint → sign in with Google.
2. Install the skill: copy `skills/deal-inbox-triage/` to `~/.claude/skills/` (Claude Code) or add it as a
   Cowork skill. Then say "triage the deal inbox".
3. Cowork schedule (suggested): weekday 08:30 — *"Run /deal-inbox-triage for the last 7 days and post the report."*
   The server also exposes the `deal_inbox_triage` and `weekly_pipeline_digest` prompts, so even without the
   skill a Claude client can pick the workflow from the prompt menu.

## ChatGPT
Settings → Connectors → *Create* → MCP server URL = the endpoint, authentication OAuth. The server
implements the `search` / `fetch` pair ChatGPT requires for deep-research connectors, plus every
EasyVC tool for use in chat with Developer Mode. Try: *"Use EasyVC to scan the deal inbox and tell me
what's new"* — the model calls `scan_deal_inbox`, shows candidates, then `ingest_inbox_messages` on approval.

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
