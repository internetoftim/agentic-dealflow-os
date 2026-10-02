-- A deal is a data room: several decks can be linked to it. Exactly one deck is
-- the primary (sets the deal's identity, feeds deep research); the others are
-- attached and ground chat and memos. See supabase/functions/_shared/deck-sources.ts.

ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS label text;

-- Backfill: the earliest deck of every deal becomes its primary. Supporting
-- documents attached from email (source_type = 'attachment') are never primary.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY deal_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.sources
  WHERE source_type <> 'attachment'
)
UPDATE public.sources s
SET is_primary = true
FROM ranked r
WHERE r.id = s.id
  AND r.rn = 1
  AND NOT EXISTS (SELECT 1 FROM public.sources p WHERE p.deal_id = s.deal_id AND p.is_primary);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_one_primary_per_deal
  ON public.sources (deal_id) WHERE is_primary;

-- Every existing ingestion path (upload, Gmail, intake, link capture, agents)
-- inserts sources without knowing about is_primary. The first deck of a deal
-- becomes primary automatically; later decks stay attached unless promoted.
CREATE OR REPLACE FUNCTION public.sources_default_primary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_primary THEN
    -- An explicit primary replaces the current one.
    UPDATE public.sources SET is_primary = false WHERE deal_id = NEW.deal_id AND is_primary;
  ELSIF NEW.source_type <> 'attachment'
        AND NOT EXISTS (SELECT 1 FROM public.sources WHERE deal_id = NEW.deal_id AND is_primary) THEN
    NEW.is_primary := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sources_default_primary ON public.sources;
CREATE TRIGGER trg_sources_default_primary
  BEFORE INSERT ON public.sources
  FOR EACH ROW EXECUTE FUNCTION public.sources_default_primary();

-- Promote a deck to primary atomically. SECURITY INVOKER: RLS still applies, so
-- only the owner of the source can call it successfully.
CREATE OR REPLACE FUNCTION public.set_primary_source(_source_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _deal uuid;
BEGIN
  SELECT deal_id INTO _deal FROM public.sources WHERE id = _source_id AND user_id = auth.uid();
  IF _deal IS NULL THEN
    RAISE EXCEPTION 'source not found';
  END IF;
  UPDATE public.sources SET is_primary = false WHERE deal_id = _deal AND is_primary AND id <> _source_id;
  UPDATE public.sources SET is_primary = true WHERE id = _source_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_primary_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_primary_source(uuid) TO authenticated;

-- If the primary deck is removed, the earliest remaining deck takes over so a
-- deal with decks always has a primary.
CREATE OR REPLACE FUNCTION public.sources_promote_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.is_primary THEN
    UPDATE public.sources SET is_primary = true
    WHERE id = (
      SELECT id FROM public.sources
      WHERE deal_id = OLD.deal_id AND source_type <> 'attachment'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    );
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_sources_promote_after_delete ON public.sources;
CREATE TRIGGER trg_sources_promote_after_delete
  AFTER DELETE ON public.sources
  FOR EACH ROW EXECUTE FUNCTION public.sources_promote_after_delete();

CREATE INDEX IF NOT EXISTS idx_sources_user_created ON public.sources (user_id, created_at DESC);

-- Capture jobs for an attached deck are marked so "re-run this deal" and the
-- deal's capture status keep following the primary deck's link.
ALTER TABLE public.capture_jobs ADD COLUMN IF NOT EXISTS attach boolean NOT NULL DEFAULT false;
