-- A deal can hold several decks, and each deck gets its own copy in Google
-- Drive. Until now only the deal carried a Drive id (deals.gdrive_file_id, the
-- primary deck's copy); attached decks were never synced and had no link.
-- Each source now records its own Drive file so the UI can offer "Open in
-- Drive" per deck. The deal's column stays as the primary deck's id for the
-- code that still reads it.

ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS gdrive_file_id text;
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS drive_synced_at timestamptz;

-- Backfill: the primary deck of every synced deal is the file already in Drive.
UPDATE public.sources s
SET gdrive_file_id = d.gdrive_file_id,
    drive_synced_at = COALESCE(s.drive_synced_at, d.updated_at, now())
FROM public.deals d
WHERE d.id = s.deal_id
  AND s.is_primary
  AND d.gdrive_file_id IS NOT NULL
  AND s.gdrive_file_id IS NULL;
