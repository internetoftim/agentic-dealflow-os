## Overview

A public, no-auth page where anyone can paste a DocSend or Papermark link, provide their email, and optionally add deal info. The link gets captured to PDF via the existing `run-docsend-capture` pipeline. When it finishes, the submitter gets a Resend email with a unique dashboard URL. That dashboard is soft-gated: visitor types the same email to unlock it, then can view the deal info and download the PDF.

## User flow

1. Visitor lands on `/convert` (public, no auth).
2. Fills form: email (required), link (required), optional company name, website, LinkedIn, notes.
3. Submits → row created in new `conversion_jobs` table, capture kicked off in background.
4. Confirmation screen shows: "We'll email you at ... when it's ready" + copyable dashboard URL.
5. Backend captures deck (Cloud Run Playwright service, already deployed) → uploads PDF to storage → marks job complete → sends Resend email.
6. Recipient clicks link `/converted/<token>` → enters submitting email → dashboard shows deal details + PDF download button.

## What gets built

### Database (new migration)
- Table `conversion_jobs` (separate from `deals`, not tied to any user):
  - `id`, `token` (unguessable), `email`, `source_url`, `company_name`, `website`, `linkedin_url`, `notes`
  - `status` (pending/capturing/complete/failed), `error_message`
  - `pdf_storage_path`, `page_count`, `title`
  - `notified_at`, `created_at`, `updated_at`
- RLS: no anon or authenticated SELECT — all reads go through security-definer RPC `get_conversion_job(_token, _email)` that returns the row only if email matches (case-insensitive). Inserts happen via edge function with service role.
- New public storage prefix `conversions/<token>.pdf` in existing `decks` bucket (served via signed URL).

### Edge functions
- `submit-conversion` (public, no JWT): validates email + URL, inserts `conversion_jobs` row, fires `run-conversion` in background via `EdgeRuntime.waitUntil`, returns `{token, dashboardUrl}`.
- `run-conversion` (internal): calls the existing Cloud Run capture service, uploads PDF to `decks/conversions/<token>.pdf`, updates job row, then calls `send-conversion-email`.
- `send-conversion-email` (internal): posts to Resend via the connector gateway with a small HTML template containing the dashboard link. Requires the Resend connector to be linked (I'll prompt for connect).
- `get-conversion` (public): thin wrapper around the `get_conversion_job` RPC that also returns a short-lived signed URL for the PDF.

### Frontend
- `src/pages/ConvertLink.tsx` at route `/convert` — the intake form, styled to match `PublicIntake.tsx`.
- `src/pages/ConversionDashboard.tsx` at route `/converted/:token` — email gate → deal detail card → PDF download button. Polls `get-conversion` every 5s while status is not terminal.
- Wire routes in `src/App.tsx`.
- Add JSON-LD/meta via Helmet to match SEO patterns.

### Secrets / connectors
- Requires the **Resend** connector. I'll surface the `standard_connectors--connect` card before wiring the email function; if you skip, I'll still ship the flow and just show the dashboard URL on the confirmation screen (email disabled until connected).

## Non-goals
- No account creation, no login, no link to your authenticated deal pipeline.
- No editing after submission (one-shot).
- No sharing beyond whoever has token + email.

## Security notes
- Email gate is soft — token alone doesn't reveal the deck; email must match. Rate-limit the `get-conversion` endpoint per IP to slow guessing.
- Signed URLs expire in 1 hour; refreshed each dashboard view.
- Input validation with zod on both edge functions.
