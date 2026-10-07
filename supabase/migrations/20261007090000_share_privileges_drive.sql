-- Sharing a deal grants the collaborator everything they need to review it:
--   1. the deal's files in storage (decks bucket), not only the database rows;
--   2. the owner can see who joined (recipient profiles);
--   3. view access to the deal's Google Drive files (every deck copy and the
--      memo PDF), tracked per file in deal_share_drive_grants so revoking a
--      collaborator removes their Drive permission too.
-- The Drive grants themselves are made by the deal-share-drive edge function
-- with the owner's Google token; this migration only adds the ledger.

-- 1. Collaborators can read a stored file when it belongs to a source of a
--    deal they can access. Keyed on sources.storage_path, so it does not
--    depend on how the path is laid out.
CREATE INDEX IF NOT EXISTS idx_sources_storage_path ON public.sources (storage_path);

CREATE OR REPLACE FUNCTION public.can_read_deck_object(_name text, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.sources s
    WHERE s.storage_path = _name
      AND public.can_access_deal(s.deal_id, _user_id)
  );
$$;
REVOKE ALL ON FUNCTION public.can_read_deck_object(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_read_deck_object(text, uuid) TO authenticated;

DROP POLICY IF EXISTS "Deal collaborators can read deck files" ON storage.objects;
CREATE POLICY "Deal collaborators can read deck files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'decks' AND public.can_read_deck_object(name, auth.uid()));

-- 2. The owner sees the name/email of people who joined their deals, and a
--    collaborator sees the owner's.
DROP POLICY IF EXISTS "Share owners and recipients see each other" ON public.profiles;
CREATE POLICY "Share owners and recipients see each other"
  ON public.profiles FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.deal_share_access a
    WHERE a.revoked_at IS NULL
      AND ((a.owner_id = auth.uid() AND a.user_id = profiles.user_id)
        OR (a.user_id = auth.uid() AND a.owner_id = profiles.user_id))
  ));

-- 3. The memo PDF's Drive copy, so it can be shared like the decks.
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS memo_gdrive_file_id text;

-- 4. One row per (collaborator, Drive file): what was granted, and when it
--    was taken back.
CREATE TABLE IF NOT EXISTS public.deal_share_drive_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_id uuid NOT NULL REFERENCES public.deal_share_access(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  recipient_email text,
  drive_file_id text NOT NULL,
  permission_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'failed', 'revoked')),
  error text,
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (access_id, drive_file_id)
);
CREATE INDEX IF NOT EXISTS idx_share_drive_grants_deal ON public.deal_share_drive_grants (deal_id);

ALTER TABLE public.deal_share_drive_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners and recipients read drive grants" ON public.deal_share_drive_grants;
CREATE POLICY "Owners and recipients read drive grants"
  ON public.deal_share_drive_grants FOR SELECT TO authenticated
  USING (auth.uid() = owner_id OR auth.uid() = recipient_id);
-- Writes come only from the edge function (service role).
GRANT SELECT ON public.deal_share_drive_grants TO authenticated;
GRANT ALL ON public.deal_share_drive_grants TO service_role;
