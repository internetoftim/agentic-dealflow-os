# Google OAuth verification — moving EasyVC from Testing to Production

## Why it matters
In **Testing** an external app is capped at 100 test users and Google expires every refresh token
after 7 days — which is why Gmail/Drive features silently stopped working weekly. Publishing removes
both limits; verification removes the "unverified app" interstitial.

## What the code now guarantees (done)
| Requirement | Where |
|---|---|
| Minimal scopes at sign-in: `openid email profile` + `drive.file` (non-sensitive) | `src/contexts/AuthContext.tsx` `BASE_SCOPES` |
| Restricted Gmail scope requested **incrementally**, only when the user enables Gmail ingestion | `requestGmailAccess()`; Settings → Gmail toggle |
| No redundant scopes (`gmail.readonly` dropped everywhere; `gmail.modify` covers it) | AuthContext, `receiver-oauth` |
| Privacy Policy and Terms on the app domain, linked from the homepage | `/privacy`, `/terms`, login footer |
| Google API Services User Data Policy **Limited Use** disclosure, verbatim, on homepage + policy | `GOOGLE_LIMITED_USE_DISCLOSURE` |
| Tokens encrypted at rest (AES-256-GCM), never readable by the browser | `_shared/google-tokens.ts`; `user_settings` column grants revoked |
| Tokens written server-side only | `store-google-tokens` function |
| User can revoke and delete (revocation at Google + full data deletion) | Settings → Data & privacy; `account` function |
| Approval gate actually enforced (the homepage claims invite-only) | `ProtectedRoute` + `on_auth_user_created` trigger |

## Console configuration (you)
1. **OAuth consent screen** (Google Auth Platform → Branding): app name *EasyVC*, logo, support email,
   developer contact, **App home page** `https://www.onepointsix.ai`, **Privacy policy**
   `https://www.onepointsix.ai/privacy`, **Terms** `https://www.onepointsix.ai/terms`,
   **Authorized domains** `onepointsix.ai`, `supabase.co` (redirects live there).
2. **Domain verification**: verify `onepointsix.ai` in Search Console with the same Google account.
3. **Scopes** (Data access): keep exactly `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
   `openid`, `.../auth/drive.file`, `.../auth/gmail.modify`. Remove `gmail.readonly` if listed.
4. **Publishing status → In production**, then **Prepare for verification**.
5. Deploy the current frontend to `onepointsix.ai` first (the reviewer visits the live homepage).

## Scope justifications (paste, adapt)
**drive.file** — "EasyVC saves the pitch deck it processed and the investment memo it generated into a
Drive folder the user chooses, using the user's naming convention. `drive.file` limits access to files
EasyVC created; we never list or read other Drive files."

**gmail.modify** — "Investors receive pitch decks by email. With this optional feature the user either
labels emails `deck` in their own mailbox or connects a dedicated deal-inbox mailbox; EasyVC finds
messages with PDF/PowerPoint attachments, downloads those attachments to create deal records, and
marks the processed message as read so it is not ingested twice. Marking as read is the only
modification; we never send, delete, or read message bodies beyond attachment metadata and headers
(sender, subject). `gmail.readonly` cannot mark messages read, hence `gmail.modify`."

## Demo video script (≤ 3 min, unlisted YouTube, English UI)
1. Homepage → show privacy link and disclosure → click *Continue with Google* → consent screen with
   only profile + Drive (point at the scope list).
2. Settings → toggle *Gmail auto-ingest* → second consent screen showing gmail.modify → return.
3. Gmail: apply label `deck` to an email with a PDF → back in EasyVC, pipeline card appears →
   deck opens in the workspace → Drive folder shows the saved file (drive.file in action).
4. Settings → Data & privacy → *Disconnect Google* → show Google Account permissions page no longer
   lists EasyVC.

## Restricted-scope reality check
`gmail.modify` is a **restricted** scope. Verification for it requires, in addition to the above, a
**CASA Tier 2 security assessment** by an authorized assessor (annual, paid; typically 1–3 weeks).
The hardening above (encrypted tokens, server-only token handling, RLS, deletion) is what assessors
check first. Two ways to avoid CASA entirely if it's not worth it:
- Ship without the Gmail scope: keep Drive + intake link + DocSend links + MCP; the deal inbox can be
  re-implemented on an **inbound email address** (Resend inbound → webhook) that needs no Google scope.
- Or keep Gmail features **internal-only** by publishing as an Internal app under a Workspace org.

## Also recommended
- Supabase Auth → enable *Leaked password protection* (advisor warning; harmless with Google-only sign-in).
- Supabase Auth → URL configuration: add `https://www.onepointsix.ai/**` and the preview host to redirect URLs.
- Rotate `GOOGLE_CLIENT_SECRET` if it was ever committed or shared; it never appears in this repo.
