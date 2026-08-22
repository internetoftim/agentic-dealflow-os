# Code Review — agentic-dealflow-os ("EasyVC" / OnePointSix)

**Reviewed commit:** `f1c7004` (branch `main`)
**Scope:** React/TypeScript frontend (`src/`), Supabase edge functions (`supabase/functions/`), SQL migrations + RLS (`supabase/migrations/`), and the Python capture backend (`backend/docsend_capture_service/`).
**Method:** Manual review of the core hooks/lib/contexts plus three parallel focused reviews (edge functions, Python backend, pages + RLS). Client-side findings were verified by unit tests; server-side findings are documented with concrete repro steps and fixes.

---

## Summary

The product is in good shape on the thing that matters most for a multi-tenant VC tool: **row-level tenant isolation in Postgres is correctly implemented** — every user-data table has RLS enabled with `auth.uid() = user_id` policies and matching `WITH CHECK`. The markdown rendering path is not an XSS vector (`react-markdown` without `rehype-raw`).

The real risks are concentrated in the **edge functions and the Python capture service**, where several endpoints run with `verify_jwt = false` and either don't authenticate the caller or trust identifiers (`userId`, `dealId`, `storagePath`) straight from the request body. The single most serious issue is an **unauthenticated cross-tenant write in `ingest-relay`**, closely followed by an **SSRF in the capture backend**.

### Severity tally

| Severity | Count | Area |
|---|---|---|
| Critical | 2 | `ingest-relay` IDOR, capture-service SSRF |
| High | 5 | `sync-to-drive`, `process-deck`, `gmail-webhook`, blocking-LLM-in-loop, unauth MCP proxy + OOM |
| Medium | 11 | auth-gate not enforced, postMessage trust, OAuth return-path, cross-deal chat leak, several edge-fn ownership gaps, capture-service robustness |
| Low | 10+ | open redirect, info disclosure, dead/misleading state, dep hygiene |

### Fixed in this branch (with tests)

| Bug | Fix | Test |
|---|---|---|
| `getFileExtension` returned the last character for extension-less names (`"deck"` → `"k"`), leaking a bogus extension into upload + intake validation. Duplicated in two files. | Extracted to `src/lib/fileType.ts` (single source), returns `""` when there is no real extension. Rewired `compressPdf.ts` and `PublicIntake.tsx`. | `src/lib/fileType.test.ts`, `src/lib/compressPdf.test.ts` |
| `useDealChat` never reset its message list when the selected deal changed, so Deal A's whole conversation was sent as context to Deal B's chat request. | Reset messages (and abort any in-flight stream) on `dealId` change. | `src/hooks/useDealChat.test.ts` (regression test) |
| `isEmailValid` was trapped inside a component and untestable. | Extracted to `src/lib/validation.ts`. | `src/lib/validation.test.ts` |

Test suite: **26 tests, all green** (`bun run test`). No production behavior changed except the two bug fixes above.

---

## Critical

### C1. `ingest-relay` — unauthenticated cross-tenant write (IDOR)
**File:** `supabase/functions/ingest-relay/index.ts` (body `userId` ~L16, service-role client ~L34, insert ~L37–49) · **`config.toml` sets `verify_jwt = false`.**

The function performs **no authentication**. It reads `userId` from the request body and then uses the **service-role key** (RLS bypassed) to insert `deals`, upload base64 images into `decks/{userId}/{dealId}/…`, and invoke `process-deck`. Anyone on the internet can `POST {images:[…], userId:"<any-uuid>", sourceName, sourceUrl}` and create/poison deals in any victim's workspace, write into their storage prefix, and drive AI spend. The injected "deck" text later flows into that victim's memo/chat — stored prompt injection.

**Fix:** Set `verify_jwt = true`; authenticate via `userClient.auth.getUser()` and derive `userId` from the token. Never trust `userId` from the body.

### C2. Capture service — SSRF via server-side rendering of a user-supplied URL
**File:** `backend/docsend_capture_service/app/main.py` (`CaptureRequest.url` ~L52, `page.goto(url)` ~L253, `/capture` + `/capture/stream` ~L364/374).

`url: HttpUrl` only constrains the scheme; any host passes. The headless browser fetches **and renders** the target and returns screenshots + PDF to the caller — a fully-readable SSRF exfiltration channel. A "deck link" of `http://169.254.169.254/…`, `http://10.0.0.5/admin`, or `http://metadata.google.internal` is rendered and read back. IP-blocklisting alone is insufficient (DNS rebinding).

**Fix:** Validate the URL host against an explicit allowlist of deck-viewer domains (docsend.com, papermark.com, pandadoc.com, …) before `page.goto`. Combine with C2-adjacent hardening in H2/H4 below.

---

## High

### H1. `sync-to-drive` — arbitrary decks-bucket read → exfiltration to attacker's Drive
**File:** `supabase/functions/sync-to-drive/index.ts` (download of body-supplied `storagePath` via service role ~L135–140; deal update by `id` only ~L235–238).

In the user-JWT path, `storagePath` comes from the body and is downloaded with the **service-role** client with no check that the path belongs to the caller. An authenticated attacker passes their own `dealId` + a victim's `storagePath` (`victimUser/victimDeal/deck.pdf`); the victim's confidential deck is uploaded into the **attacker's** Google Drive. The final `deals.update().eq("id", dealId)` is likewise unscoped.

**Fix:** Assert `storagePath.startsWith(resolvedUserId + "/")` and scope every deal read/update with `.eq("user_id", resolvedUserId)`.

### H2. `process-deck` — missing deal-ownership check → cross-tenant tampering
**File:** `supabase/functions/process-deck/index.ts` (user path resolves `userId` but never verifies deal ownership; deal writes keyed by `.eq("id", dealId)` only at ~L403/579/690/718/725/903/936).

Authenticated attacker calls `{dealId:<victimDealId>, storagePath:<attacker's own upload>}`; the victim's deal row is overwritten with metadata from the attacker's file and driven through the pipeline. (The service-role branch is fine; only the user branch is exploitable.)

**Fix:** Load the deal with `.eq("id", dealId).eq("user_id", userId)`, 404 on mismatch, and scope all deal writes by `user_id`. `deep-research/index.ts` already does this correctly and is the pattern to copy.

### H3. `gmail-webhook` — no Pub/Sub verification; forgeable notifications
**File:** `supabase/functions/gmail-webhook/index.ts` (accepts + decodes `emailAddress`/`historyId` with no auth ~L155–189; writes attacker-controlled `newHistoryId` ~L407–410).

The handler never verifies Google's signed OIDC push token. Since the webhook must be publicly reachable, an attacker POSTs a crafted envelope with any `emailAddress`/`historyId`. It matches the victim by email and uses the victim's stored OAuth token to walk their Gmail; a high `historyId` makes them silently miss all future deck emails, a low one forces mass re-ingestion.

**Fix:** Verify the `Authorization: Bearer` OIDC JWT from Pub/Sub (issuer `accounts.google.com`, expected audience/service account) before processing.

### H4. Capture service — blocking LLM call on the async event loop
**File:** `backend/docsend_capture_service/app/main.py` (`AG2Planner.get_plan` sync ~L81 → `initiate_chat` ~L156, called from async `_get_plan` with no `await`/executor ~L180).

When `OPENAI_API_KEY` is set, every page turn issues a synchronous OpenAI round-trip on the event-loop thread, freezing `/health` and all in-flight captures for the full LLM latency, repeatedly.

**Fix:** `await asyncio.to_thread(self.planner.get_plan, html)` and cache one plan per capture.

### H5. Capture service — unauthenticated MCP proxy + unbounded concurrency (OOM/DoS)
**File:** `backend/docsend_capture_service/mcp_server.py` (`FastMCP(host="0.0.0.0")`, `capture_docsend` tool, SSE for Cloud Run) and `app/main.py` (no concurrency guard; per-request `chromium.launch`; up to 100 full-page base64 PNGs held in memory and returned + re-encoded into a PDF).

The MCP server exposes captures with no auth while holding `SERVICE_API_KEY`, turning C2 into an **unauthenticated** SSRF for anyone who can reach it. Separately, a handful of concurrent large-deck captures exhaust memory and OOM-kill the instance.

**Fix:** Require auth on the MCP transport (Cloud Run IAM + app token) and never deploy `--allow-unauthenticated`; gate captures behind an `asyncio.Semaphore(1–2)` and cap total captured bytes.

---

## Medium

- **M1. Approval gate is decorative.** `src/App.tsx` `ProtectedRoute` only checks `if (!user)`. `LoginPage` advertises "invite-only, admin approval," and `is_user_approved()` + an `approval_status` workflow exist in migrations (`20260423141110`), but `is_user_approved` is **never called** and no RLS references it. Any Google account gets a full workspace. *Fix: gate `ProtectedRoute` and, authoritatively, the deals/sources RLS on `is_user_approved(auth.uid())`.*

- **M2. `IngestRelay` trusts cross-origin `postMessage` with no handshake.** `src/pages/IngestRelay.tsx:46-71` processes `DECK_INGESTION` and uploads as the logged-in user. **Note:** a naive same-origin check is *wrong here* — the bookmarklet posts from a third-party origin (docsend.com) by design (`BookmarkletInstaller.tsx:120-125`), so `event.origin === location.origin` would break the feature. The correct fix is a **nonce/passcode handshake**: the `passcode` field is already destructured in the relay (`IngestRelay.tsx:52`) but neither sent by the bookmarklet nor verified. *Fix: have the app mint a one-time passcode, embed it in the relay URL/bookmarklet, and reject messages whose passcode doesn't match.*

- **M3. OAuth discards the deep-link return path.** `AuthContext.tsx:98` hardcodes `redirectTo: window.location.origin`; `LoginPage` ignores `?next=`. Logged-out users opening `/share/:token` (`AcceptShare.tsx`) or `/mcp/authorize` (`McpAuthorize.tsx:25-27`) land on `/` after login and the intended action never runs — share links are silently never accepted; MCP authorize breaks. *Fix: thread the return path through OAuth and honor `?next=` in `LoginPage`.*

- **M4. Cross-deal chat context leak.** `useDealChat` didn't reset on deal switch. **Fixed in this branch** (see summary) with a regression test.

- **M5. `public-intake` routes DocSend submissions to the wrong function.** `public-intake/index.ts:233-243` invokes `ingest-relay` with `{dealId, url, userId}`, but `ingest-relay` requires a non-empty `images[]` and 400s. A founder submitting a DocSend link (no file) gets `{status:"success"}` while the deal is stranded forever. *Fix: route DocSend URLs into the capture pipeline (`capture_jobs` + `run-docsend-capture`).*

- **M6. `gmail-listener` — no auth (`verify_jwt=false`) + unscoped `retryDealId`.** Anyone can trigger a full multi-user Gmail poll (resource abuse), and `retryDealId` re-fires `process-deck` for any deal id with no ownership check. *Fix: require the service-role/cron secret; scope the retry lookup.*

- **M7. `admin-cleanup-redundant-pptx` — destructive, no authorization.** Defaults to `verify_jwt=true`, so *any* logged-in user (not just an admin) can delete `.pptx/.ppt` originals across **all** users' storage. Also imports `npm:@supabase/supabase-js@2/cors`, which is not a real export of that package. *Fix: gate behind an admin secret; define `corsHeaders` locally.*

- **M8. `docsend-callback` — service-role secret passed in the JSON body**, compared non-constant-time; `user_id`/`deal_id` from body are never cross-checked for consistency. *Fix: move the shared secret to a header, use a dedicated non-service-role callback secret with `timingSafeEqual`, and validate `deal_id`'s owner.*

- **M9. Capture service — browser/context leaked on error.** `app/main.py:241-285` closes the browser only on the happy path; a `goto` timeout or mid-capture exception skips `context.close()/browser.close()`. *Fix: `try/finally`.*

- **M10. Capture service — raw exception text returned to the caller** (`main.py:371`, SSE `:383`) leaks internal hosts/ports and gives a precise blind-SSRF oracle. *Fix: log server-side, return a generic message.*

- **M11. Capture-service frontend SSE parser** (`frontend.py:34-49`) dispatches only the last message per chunk (dispatch `if` is outside the parse `while`) and can raise `UnboundLocalError` on a keepalive-first chunk. *Fix: move dispatch inside the loop and guard `msg`.*

---

## Low

- **L1. `McpAuthorize` "Deny" is an open redirect.** `McpAuthorize.tsx:65-70` does `window.location.href = new URL(redirect_uri).toString()` from the unvalidated query param. *Fix: validate `redirect_uri` against the registered client before redirecting.*
- **L2. `lookup_share_token` discloses the owner's email** (`20260502165721…sql:104`, `COALESCE(display_name, email, …)`, granted `TO anon`). *Fix: drop the `email` fallback.*
- **L3. Share "People with access" names never resolve.** `useDealShare.ts:119-123` reads `profiles` for recipients, but `profiles` RLS is own-row-only, so names/emails are always null. *Fix: resolve via a `SECURITY DEFINER` RPC.*
- **L4. Shared recipients' "Download Deck" always fails.** `DealWorkspace.tsx:423-438` reads the owner-folder-only `decks` bucket. *Fix: hide the button for non-owners or serve via signed URL.*
- **L5. `deal_shares.permission` ('view_chat') is never enforced by RLS** — dead state that will silently under-protect the moment a narrower tier is added.
- **L6. `mcp-server` `search_deals` PostgREST `.or()` injection** (`index.ts:182-188`, `query` interpolated). Confined to the caller's own rows, but can break filtering / throw. *Fix: escape `,`/`()`/`*` or use `.textSearch`.*
- **L7. `detect-pattern` targets the wrong host/auth** for the default `gpt-oss-202b` model (`api.sapinsapin.com` + `Bearer` vs the Apollo bridge + `X-API-Key` used everywhere else) — default path fails. *Fix: align host + header.*
- **L8. `test-capture` is a leftover debug endpoint** with a hardcoded user id and no real auth. *Fix: remove from prod.*
- **L9. Capture service:** non-constant-time API-key compare (`main.py:35`), sensitive deck URLs (with gate tokens) logged at INFO (`:239`), duplicate trailing pages from an over-eager keyboard-fallback (`:189-195`), orphaned capture on client disconnect (`:385-392`), and a dead `markdown` field the backend never returns (`frontend.py:66`).
- **L10. Dependency hygiene:** `requirements.txt` leaves `mcp[cli]`, `httpx`, `playwright-stealth`, `pyngrok`, `numpy` unpinned; the capture `Dockerfile` runs Chromium as **root** while rendering untrusted pages.

---

## GCP deployment / Cloud Run (reviewed on request)

The GCP-deployed "cloud function" is the `docsend_capture_service`, shipped as **two Cloud
Run services** — `docsend-backend` (the FastAPI capture app) and `docsend-mcp` (the MCP
server) — plus a frontend, via `deploy-backend.sh` / `deploy-mcp.sh` / `deploy.sh` and the
`Deploy Backend` GitHub Action. The service *code* is reviewed above (C2, H4, H5, M9–M11,
L9–L10). The deploy pipeline adds infra-level findings:

- **G1 (High — infra root cause of C2 + H5).** Both services deploy with
  **`--allow-unauthenticated`** (`deploy-backend.sh:51`, `deploy-mcp.sh:47`). The MCP server
  is public, holds `SERVICE_API_KEY`, and forwards to the backend — so the capture SSRF
  (C2) is reachable **without any credential** by anyone on the internet (H5). *Fix: require
  auth on the Cloud Run ingress (drop `--allow-unauthenticated`; use IAM / an authenticating
  proxy), or at minimum gate the MCP server with its own token.*
- **G2 (Low).** The auto-generated `SERVICE_API_KEY` is echoed to stdout
  (`deploy-backend.sh:24`), so it lands in CI/terminal logs. *Fix: don't print generated
  secrets.*
- **G3 (Low — hygiene, not a leak).** `.env` is **tracked in git** despite the `*.env`
  gitignore rule (committed before the rule took effect). It currently contains only the
  public Supabase URL + anon/publishable key (no service-role/OpenAI/service secret; the
  backend `.env` with real secrets is correctly untracked), so there is no secret exposure
  today — but it should be `git rm --cached .env` to prevent a future real secret from being
  committed to that path.
- **G4 (Info).** `_common.sh:16` hardcodes a developer's local SDK path
  (`/Users/tims/google-cloud-sdk/bin`); harmless but non-portable.
- **Clean:** the Action (`.github/workflows/deploy.yml`) prefers Workload Identity
  Federation with an SA-key fallback and requests least-privilege token scopes
  (`contents: read`, `id-token: write`); secrets are stored in Secret Manager and mounted
  via `--set-secrets`, not baked into images.

## What looked clean (verified)

- **RLS tenant isolation** across `deals`, `sources`, `user_settings`, `capture_jobs`, `deal_people`, `profiles`, `user_roles`, `deal_shares`, `deal_share_access`, `mcp_*` — enabled with correct `USING`/`WITH CHECK`; the only `USING (true)` policies are `TO service_role`. A historical hole (anon could read `google_provider_token` via the intake-slug SELECT policy, `20260413150139`) was **dropped** by the final migration `20260717174753`.
- **No markdown XSS:** `react-markdown@10` used without `rehype-raw`/`remark-html`; raw HTML is escaped.
- **Edge functions `deal-chat`, `generate-memo`, `process-docsend`, `deep-research`, `gmail-watch`** authenticate and scope by `user_id` correctly.
- **Token generation** (share tokens, MCP PATs) uses `crypto` randomness; PATs are stored only as SHA-256 hashes.
- **Capture backend:** no shell/command injection, no path traversal (captures go to in-memory `BytesIO`), no open CORS, auth fails closed when `SERVICE_API_KEY` is unset.

> Note: `react-helmet-async@3.0.0` (and transitive `react-fast-compare`, `shallowequal`) fail to install in a plain public-npm environment (they resolve from a Lovable private registry mirror). This is an environment/registry artifact, not an application defect — it does not affect Lovable builds.
