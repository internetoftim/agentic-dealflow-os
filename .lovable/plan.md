

## Public Deck Intake Portal

### Overview

Create a publicly accessible page (no login required) where a VC user can share a link with founders to upload their pitch decks. Uploaded decks feed into the existing deal pipeline using the same processing flow as manual uploads.

### Architecture

```text
Founder visits:  /intake/:userId
        │
        ▼
  PublicIntake.tsx  (no auth required)
  - Upload form: file + company name + optional email
  - Drag & drop support
  - Progress feedback
        │
        ▼
  Edge Function: public-intake (no JWT, uses service role)
  - Validates input (file size, type, required fields)
  - Creates deal record (source: "public-intake")
  - Compresses & uploads file to storage
  - Creates source record
  - Triggers process-deck pipeline
  - Returns success
```

### Changes

#### 1. New Edge Function: `supabase/functions/public-intake/index.ts`

- **No JWT required** — this is a public endpoint
- Accepts multipart form data: `file` (PDF/PPTX), `userId` (from URL), `companyName`, `submitterEmail` (optional), `submitterName` (optional)
- Validates: userId exists in deals table (any user row), file type is PDF/PPTX, file size < 20MB
- Creates deal with `source: "public-intake"`, `auto_ingested: true`
- Uploads file to `decks` bucket under `{userId}/{dealId}/`
- Creates source record with `source_type: "public-intake"`
- Invokes `process-deck` (fire-and-forget)
- Returns `{ status: "success", dealId }`

#### 2. New Page: `src/pages/PublicIntake.tsx`

- Route: `/intake/:userId` — **outside** the ProtectedRoute wrapper
- Clean, minimal branded page (uses existing design tokens)
- Shows: company name input, file upload (drag & drop + click), optional submitter name/email fields
- File validation: PDF/PPTX only, max 20MB
- Upload progress states: idle → uploading → success → error
- On success: "Thank you" confirmation with checkmark
- Calls the `public-intake` edge function directly via fetch (not supabase client, since no auth)

#### 3. Route Addition: `src/App.tsx`

- Add `/intake/:userId` route **outside** the ProtectedRoute wrapper, alongside `/login`

#### 4. Settings Page Addition: `src/pages/SettingsPage.tsx`

- Add a "Public Intake Link" section showing the user's shareable URL
- Copy-to-clipboard button
- Format: `https://easyvc.lovable.app/intake/{userId}`

### Security Considerations

- The edge function uses service role key internally but validates the target `userId` exists
- Rate limiting: basic check — reject if the user already has >50 deals with source "public-intake" in the last 24h
- File type validation on both client and server
- No sensitive data exposed — the userId in the URL is a UUID (not guessable, but not secret either)

### No Database Changes Required

The existing `deals` and `sources` tables already support all needed fields. The new `source: "public-intake"` value is just a text string.

