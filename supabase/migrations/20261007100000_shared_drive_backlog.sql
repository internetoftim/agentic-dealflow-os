-- Deals whose Google Drive permissions are out of step with who they are
-- shared with: an active collaborator lacks a granted permission on one of
-- the deal's Drive files, or a revoked collaborator still holds one. The
-- one-minute cron (gmail-listener) reconciles these through deal-share-drive,
-- so access never depends on a browser call succeeding. A failed grant (for
-- example the owner's Google connection lapsed) is retried at most hourly.

CREATE OR REPLACE FUNCTION public.shared_deals_needing_drive_sync(_limit int DEFAULT 5)
RETURNS TABLE (deal_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH files AS (
    SELECT s.deal_id, s.gdrive_file_id AS file_id FROM public.sources s WHERE s.gdrive_file_id IS NOT NULL
    UNION SELECT d.id, d.gdrive_file_id FROM public.deals d WHERE d.gdrive_file_id IS NOT NULL
    UNION SELECT d.id, d.memo_gdrive_file_id FROM public.deals d WHERE d.memo_gdrive_file_id IS NOT NULL
  ),
  missing AS (
    SELECT a.deal_id
    FROM public.deal_share_access a
    JOIN files f ON f.deal_id = a.deal_id
    LEFT JOIN public.deal_share_drive_grants g ON g.access_id = a.id AND g.drive_file_id = f.file_id
    WHERE a.revoked_at IS NULL
      AND (g.id IS NULL
        OR g.status = 'pending'
        OR g.status = 'revoked'
        OR (g.status = 'failed' AND g.updated_at < now() - interval '1 hour'))
  ),
  stale AS (
    SELECT g.deal_id
    FROM public.deal_share_drive_grants g
    JOIN public.deal_share_access a ON a.id = g.access_id
    WHERE a.revoked_at IS NOT NULL AND g.status = 'granted'
  )
  SELECT DISTINCT x.deal_id FROM (SELECT deal_id FROM missing UNION SELECT deal_id FROM stale) x
  LIMIT _limit;
$$;
REVOKE ALL ON FUNCTION public.shared_deals_needing_drive_sync(int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shared_deals_needing_drive_sync(int) TO service_role;
