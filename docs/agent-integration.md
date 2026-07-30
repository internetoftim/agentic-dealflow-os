# Agent Integration (Agent Mode)

EasyVC ships an MCP (Model Context Protocol) server so AI agents — Claude
Desktop, Cursor, the Anthropic/OpenAI SDKs, etc. — can work with a user's deal
workspace. Access comes in **two tiers**:

| Tier | Availability | Tools |
|---|---|---|
| **Default** | Always on for every connected agent | `list_deals`, `get_deal`, `search_deals`, `get_deal_context` (read-only) |
| **Agent Mode** | Opt-in, per user, toggled in **Settings → Agent Mode** | The read tools above **plus** the write/orchestration tools below |

When Agent Mode is **off**, the server behaves exactly as it always has: only
the four read tools are advertised (`tools/list`) and callable. Nothing about
the default experience changes. Agent Mode is purely additive.

## Enabling Agent Mode

1. Sign in to EasyVC.
2. Go to **Settings → Agent Mode** and flip the toggle on. (You can also click
   **Enable Agent Mode** from the *AI Agents (MCP)* card.)
3. The toggle is an instant **kill switch**: turn it off and every write tool
   immediately returns an error, agent UI affordances disappear, and the
   `/agent/deal/:id` deep-link route returns 404.

Recent agent activity (the last write calls made on your behalf) is listed
under the Agent Mode section in Settings, sourced from the `mcp_tool_calls`
audit log.

## Connecting an agent

### Personal access token (PAT)

Create a token under **Settings → AI Agents**, then add it to your MCP client:

```json
{
  "mcpServers": {
    "easyvc": {
      "url": "https://<project>.supabase.co/functions/v1/mcp-server",
      "headers": { "Authorization": "Bearer pat_..." }
    }
  }
}
```

A PAT is **all-or-nothing**: while Agent Mode is on it can use *every* write
tool. There is no per-token scope. Revoke a token from the same screen to cut
off access.

### OAuth 2.1

Clients that support OAuth (Claude, ChatGPT) can connect with just the server
URL. On the consent screen:

- Read access is always granted.
- A **"make changes on your behalf"** checkbox appears **only if you have Agent
  Mode enabled**. Checking it grants the `mcp:write` scope. Leave it unchecked
  for a read-only connection.
- If you authorize while Agent Mode is off, the server strips `mcp:write` — the
  grant is read-only regardless of what the client requested.

So an OAuth agent needs **both** Agent Mode on **and** the `mcp:write` scope to
call write tools. A PAT needs only Agent Mode on.

## Safety model

- **Ownership pre-checks** — every write tool verifies the target deal/person/
  source belongs to the calling user before mutating. A foreign id returns
  `Deal not found` (as an `isError` result), never a cross-tenant write.
- **Audit log** — each write call records `{ user_id, tool, args_hash, deal_id,
  via, created_at }` in `mcp_tool_calls`.
- **Rate limit** — write calls are capped per user over a rolling one-hour
  window; exceeding it returns an `isError` rate-limit message.
- **Column whitelist** — `update_deal` only accepts a fixed set of editable
  fields and refuses `status`/`stage` (those are managed by the ingestion
  pipeline, not agents).
- **Errors are `isError` results, not HTTP failures** — a disabled Agent Mode,
  a rate-limit hit, or an ownership miss all come back as a normal JSON-RPC
  response with `isError: true`, so clients surface them as tool errors.

## Tool reference (Agent Mode)

### Read (also gated behind Agent Mode)
- `list_deal_people { deal_id }` — key people on a deal.
- `list_sources { deal_id }` — attached sources.
- `get_job_status { deal_id }` — poll `status` + `deep_research_status` for
  async jobs.

### Deals
- `create_deal { name, sector?, website?, ask_amount?, valuation?, revenue?,
  growth?, nrr?, team_size? }` — creates a deal owned by you (`source: 'agent'`,
  `status: 'inbox'`).
- `update_deal { deal_id, patch }` — whitelisted fields only (name, sector,
  website, linkedin_url, ask_amount, valuation, revenue, growth, nrr,
  team_size). Refuses `status`/`stage`.
- `delete_deal { deal_id }` — cascade-deletes the deal and its children.

### People
- `add_deal_person { deal_id, name, title?, linkedin_url? }`
- `update_deal_person { person_id, patch }`
- `remove_deal_person { person_id }`

### Sources
- `attach_source_url { deal_id, url, label? }`
- `attach_source_text { deal_id, text, label? }`
- `attach_deck_from_url { deal_id, url }` — records the deck link as a source.
- `delete_source { source_id }`

### Notes & memo
- `append_note { deal_id, body }` — appends to the deal's notes (`deal_notes`).
- `update_memo_draft { deal_id, memo_draft }`

### Orchestration (async — poll `get_job_status`)
- `run_deep_research { deal_id }`
- `run_process_deck { deal_id, storage_path }`
- `generate_memo { deal_id }`

## Recipes

**Claude adds a founder's LinkedIn**
> "In EasyVC, add Jane Doe (CEO, linkedin.com/in/jane) to the Acme deal."

The agent calls `search_deals` → `add_deal_person { deal_id, name: "Jane Doe",
title: "CEO", linkedin_url: "https://linkedin.com/in/jane" }`.

**Codex ingests a deck and drafts a memo**
1. `attach_deck_from_url { deal_id, url }` (or `run_process_deck` with a stored
   deck path)
2. `run_deep_research { deal_id }`
3. Poll `get_job_status { deal_id }` until research completes
4. `generate_memo { deal_id }`

## Agent-driven UI (deep link + bridge)

With Agent Mode on, an agent can also drive the workspace UI for
human-in-the-loop edits:

- **Deep link** — `/agent/deal/:id?prefill=<base64-json>` opens the deal with an
  "Agent-assisted edit — review & save" panel pre-filled from the payload
  (`{ deal?: {...}, person?: { name, title|role, linkedin_url } }`). The panel
  and route exist **only** while Agent Mode is on; otherwise the route 404s.
- **`window.easyvc` bridge** — on the agent route the page exposes
  `getCurrentDealId()`, `prefill(patch)`, `fillPerson(person)`, `save()`, and
  `addPerson()`. Cross-origin agents can `postMessage`
  `{ type: "EASYVC_AGENT", nonce, action, payload }`, but only if the `nonce`
  matches the one carried in the `?nonce=` query param of the URL the agent
  opened (same-origin checks alone are not trusted).

All UI affordances are gated on the same `agent_mode_enabled` flag, so the kill
switch removes them everywhere at once.
