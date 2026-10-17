# EasyVC on Claude Managed Agents

Hosted agents that capture decks, run deal diligence and review the dashboard. Anthropic
runs the agent loop and a sandbox per session. EasyVC starts sessions from Supabase edge
functions and saves the results when a webhook says a session is idle. Users reach all of it
through the EasyVC MCP server from Claude or ChatGPT.

| File | What it is |
|---|---|
| `agents/deck-capture.md` | Sonnet 5.5. Drives headless Chromium in the sandbox to turn a DocSend / Papermark / PandaDoc link into `deck.pdf`. Replaces the Cloud Run capture service. |
| `agents/deal-analyst.md` | Opus 5.5 coordinator. Delegates to the two agents below, checks their work, and writes `diligence.json` and `memo.md`. Replaces deep-research. |
| `agents/due-diligence.md` | Sonnet 5.5. Founder backgrounds and red flags, plus a verdict for every deck claim. |
| `agents/market-competition.md` | Sonnet 5.5. Market size bottom-up and top-down, market signals, competitors. |
| `agents/dashboard-reviewer.md` | Opus 5.5. Screenshots the app in demo mode, fixes what isn't simple, opens a PR. |
| `environments/easyvc-research.yaml` | Sandbox for capture and diligence (unrestricted egress, Chromium and Playwright). |
| `environments/easyvc-dashboard-review.yaml` | Sandbox for the reviewer (package managers, GitHub MCP and Google Fonts only). |
| `vaults/easyvc-dashboard-review.yaml` | Holds the GitHub MCP credential the reviewer uses to open PRs. |

Spending caps per session: diligence and dashboard review **$10**; capture **$3**. Unattended
sessions deny any tool call the server pauses for review.

## Flow

```
deck link ─► run-docsend-capture ─► capture session ─┐
                                                     ├─ agent-webhook ─► run-docsend-capture (finish) ─► process-deck
/convert  ─► run-conversion      ─► capture session ─┘                └► run-conversion (finish) ─► email

process-deck ─(DILIGENCE_AGENT=on)─► run-diligence ─► diligence session ─► agent-webhook ─► deals, deal_people,
MCP run_diligence ─────────────────►                                                         deal_diligence_runs, pipeline_runs
MCP ask_diligence ─► same session (follow-up) ─► agent-webhook saves the updated report
```

The MCP server (v1.4.0) adds `run_diligence`, `ask_diligence`, `get_diligence_run`,
`get_diligence_report` and the `deal_diligence` prompt.

## Setup (once)

1. **Create the agents and environments.** Run from this directory, so `claude-lock.json` lands here:
   ```bash
   cd managed-agents
   ant apply --dry-run -v agents/*.md environments/*.yaml vaults/*.yaml
   ant apply agents/*.md environments/*.yaml vaults/*.yaml
   ```
   Commit `claude-lock.json`. After editing a file, run `ant apply` again and the agent gets a new version.
2. **GitHub credential for PRs.** Use a fine-grained PAT for `internetoftim/agentic-dealflow-os` with
   contents and pull requests read/write:
   ```bash
   ant beta:vaults:credentials create --vault-id "$(jq -r '.resources["./vaults/easyvc-dashboard-review.yaml"].id' claude-lock.json)" \
     --display-name "GitHub MCP" --auth '{type: static_bearer, mcp_server_url: "https://api.githubcopilot.com/mcp/", token: "<PAT>"}'
   ```
   Protect `main` with a branch rule so only PRs can change it.
3. **Database:** apply `supabase/migrations/20261017090000_managed_agent_sessions.sql`. Use
   `db query` and `migration repair`, never `db push`.
4. **Webhook:** Console → Manage → Webhooks. URL
   `https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/agent-webhook`, events
   `session.status_idled` and `session.status_terminated`. Keep the `whsec_` secret.
5. **Supabase function secrets:**

   | Secret | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | API key for the workspace the agents live in |
   | `ANTHROPIC_WEBHOOK_SIGNING_KEY` | the `whsec_` secret from step 4 |
   | `ANTHROPIC_WORKSPACE_ID` | `wrkspc_…`, for Console links |
   | `MA_RESEARCH_ENV_ID` | `.resources["./environments/easyvc-research.yaml"].id` |
   | `MA_DECK_CAPTURE_AGENT_ID` | `.resources["./agents/deck-capture.md"].id` |
   | `MA_DEAL_ANALYST_AGENT_ID` | `.resources["./agents/deal-analyst.md"].id` |
   | `DOC_VIEWER_GATE_EMAIL` | the email typed into gated viewers |
   | `DILIGENCE_AGENT` | `on` to replace deep-research after every new deck |
   | `DILIGENCE_AGENT_USER_IDS` | optional comma-separated allowlist for a staged rollout |
   | `CAPTURE_BACKEND` | optional: `agent` or `cloud-run`; unset = agent once the two `MA_`/API secrets exist |
   | `CONVERSION_HOURLY_CAP` | optional: public `/convert` captures per hour (default 20) |

6. **Dashboard review:** set the repo secrets `ANTHROPIC_API_KEY` and `UI_REVIEW_GITHUB_TOKEN`, and the
   variable `ANTHROPIC_WORKSPACE_ID`. The workflow runs on Mondays, or start it by hand:
   `gh workflow run "Dashboard review"`.

## Retiring Cloud Run

Once capture sessions pass the eval on real links, delete the Cloud Run service and the
`DOCSEND_CAPTURE_SERVICE_*` secrets. Then remove the `cloud-run` branches in `run-docsend-capture`
and `run-conversion`, plus `_shared/docsend-capture-client.ts`. Until then `CAPTURE_BACKEND=cloud-run`
is the rollback.

## Evals and tuning

The rubrics in `supabase/functions/_shared/agent-sessions-core.ts` (diligence) and
`scripts/agents/review-dashboard.mjs` (dashboard) are starters. `/claude-api build-eval` builds
the eval set, and `/claude-api hillclimb` tunes prompts, effort and models against it. Bump
`DILIGENCE_VERSION` / `CAPTURE_VERSION` whenever a prompt changes so `pipeline_runs` attributes results.
