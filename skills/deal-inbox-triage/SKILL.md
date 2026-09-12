---
name: deal-inbox-triage
description: Triage the EasyVC deal inbox through the EasyVC MCP connector — scan a receiver Gmail inbox for new pitch decks, confirm with the user, ingest with real message ids, kick off deep research and memos, and report uploaded / attached / duplicate / unsupported / failed. Use when the user says "check the deal inbox", "any new decks?", "triage inbound", "what came in this week", or on a schedule.
---

# Deal inbox triage

You operate EasyVC through its MCP connector (`easyvc`). The human decides; you do the work and report precisely, using the real identifiers the tools return.

## Preconditions
- The `easyvc` connector is connected (tools like `scan_deal_inbox` are available). If not, tell the user to add it: Claude → Settings → Connectors → Add custom → `https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/mcp-server` (OAuth) — or a Personal Access Token from EasyVC Settings → AI Agents.
- Write tools need **Agent Mode** on (EasyVC Settings → AI Agents). Check with `get_agent_mode` if a write fails.
- A receiver inbox must exist (`list_receiver_inboxes`). If none: call `create_receiver_invite` and hand the link to whoever controls the mailbox — no EasyVC account needed on their side.

## Procedure
1. **Scan, don't ingest.** `scan_deal_inbox` (optionally `receiver_email`, `since_days`). It is read-only.
2. **Present.** Compact table: sender · subject · date · attachments with kind (deck / document / unsupported). Group messages that share a `thread_id`. Flag likely spam, newsletters, internal forwards. If a thread has an older read message with a deck, it will still appear — the scan ignores read state.
3. **Confirm.** Ask which to ingest; default is all decks. Never ingest something the user flagged.
4. **Ingest.** `ingest_inbox_messages` with exactly the chosen `message_ids`. Documents (xlsx/docx/csv) in the same mail attach to the new deal as data-room sources automatically; duplicates are detected by content hash.
5. **Follow through.** For each `uploaded` deal: `run_deep_research`. If the user wants memos: after `get_deal` shows `deep_research_status=completed`, `generate_memo`.
6. **Report.** `get_ingest_report` (`since_days` as agreed). Write: new deals by name (with open links), documents attached, duplicates and what they duplicated, unsupported files with types, failures with reasons. End with one suggested next action.

## When the Tavily connector is also available (`tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`)
EasyVC's own deep research already uses Tavily server-side. Use the connector for what the pipeline
doesn't do:
- **Verify deck claims** before recommending: `tavily_search` the ARR/customer/partnership claims that
  matter; quote the source URL in your report, never the deck alone.
- **Founder diligence**: `tavily_search` `"<founder name>" <company>` and prior companies; `tavily_extract`
  their LinkedIn or personal site when the pipeline's `get_deal` shows no key people.
- **Thin research**: if `get_deal` shows `deep_research_status=failed` or empty investors/news, run
  `tavily_search` for `"<company>" funding round investors` and `"<company>" news`, then write the
  findings into the deal with `update_deal` (investors, funding_total, last_funding_round) and
  `update_memo` (mode=append, with sources).
- Prefer `tavily_extract` on a specific URL over `tavily_crawl`; crawl only a company's own site and
  cap it — it is slow and costly.

## Rules
- Idempotent by design: re-running is safe; the report shows `skipped · Already processed` for anything seen before. Don't force it.
- Quote Gmail ids only when the user asks; otherwise use names and subjects.
- If `scan_deal_inbox` errors with an expired token, the inbox must be reconnected in Settings → Deal Inbox; say so and stop.
- Keep the report under 200 words unless asked for detail.
