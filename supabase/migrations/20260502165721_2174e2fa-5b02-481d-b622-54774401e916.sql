-- Deal sharing: reusable links + per-recipient access tracking

CREATE TABLE public.deal_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  permission text NOT NULL DEFAULT 'view_chat',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX idx_deal_shares_deal ON public.deal_shares(deal_id);
CREATE INDEX idx_deal_shares_owner ON public.deal_shares(owner_id);
CREATE INDEX idx_deal_shares_token ON public.deal_shares(token);

ALTER TABLE public.deal_shares ENABLE ROW LEVEL SECURITY;

-- Owners manage their own share links
CREATE POLICY "Owners view own shares" ON public.deal_shares
  FOR SELECT TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "Owners create shares" ON public.deal_shares
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owners update shares" ON public.deal_shares
  FOR UPDATE TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owners delete shares" ON public.deal_shares
  FOR DELETE TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "Service role manages shares" ON public.deal_shares
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-user accepted access (one row per user/deal who has joined via a share)
CREATE TABLE public.deal_share_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  user_id uuid NOT NULL,
  share_id uuid NOT NULL REFERENCES public.deal_shares(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  permission text NOT NULL DEFAULT 'view_chat',
  accepted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (deal_id, user_id)
);

CREATE INDEX idx_deal_share_access_user ON public.deal_share_access(user_id);
CREATE INDEX idx_deal_share_access_deal ON public.deal_share_access(deal_id);
CREATE INDEX idx_deal_share_access_owner ON public.deal_share_access(owner_id);

ALTER TABLE public.deal_share_access ENABLE ROW LEVEL SECURITY;

-- Recipients see their own access rows; owners see who has joined their deals
CREATE POLICY "Recipients view own access" ON public.deal_share_access
  FOR SELECT TO authenticated USING (auth.uid() = user_id OR auth.uid() = owner_id);
-- Owners can revoke a recipient's access
CREATE POLICY "Owners revoke access" ON public.deal_share_access
  FOR UPDATE TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Owners delete access" ON public.deal_share_access
  FOR DELETE TO authenticated USING (auth.uid() = owner_id);
CREATE POLICY "Service role manages access" ON public.deal_share_access
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Security definer helper: can the user access this deal (own or shared)?
CREATE OR REPLACE FUNCTION public.can_access_deal(_deal_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.deals WHERE id = _deal_id AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1 FROM public.deal_share_access
    WHERE deal_id = _deal_id AND user_id = _user_id AND revoked_at IS NULL
  );
$$;

-- Extend SELECT policies on deal-related tables so shared users can read
CREATE POLICY "Shared users can view deals"
  ON public.deals FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.deal_share_access dsa
      WHERE dsa.deal_id = deals.id AND dsa.user_id = auth.uid() AND dsa.revoked_at IS NULL
    )
  );

CREATE POLICY "Shared users can view sources"
  ON public.sources FOR SELECT TO authenticated
  USING (public.can_access_deal(sources.deal_id, auth.uid()));

CREATE POLICY "Shared users can view deal people"
  ON public.deal_people FOR SELECT TO authenticated
  USING (public.can_access_deal(deal_people.deal_id, auth.uid()));

CREATE POLICY "Shared users can view capture jobs"
  ON public.capture_jobs FOR SELECT TO authenticated
  USING (public.can_access_deal(capture_jobs.deal_id, auth.uid()));

-- Token lookup helper (anonymous-safe: returns minimal info for share landing page)
CREATE OR REPLACE FUNCTION public.lookup_share_token(_token text)
RETURNS TABLE (deal_id uuid, deal_name text, owner_display_name text, revoked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    d.id AS deal_id,
    d.name AS deal_name,
    COALESCE(p.display_name, p.email, 'A teammate') AS owner_display_name,
    (s.revoked_at IS NOT NULL) AS revoked
  FROM public.deal_shares s
  JOIN public.deals d ON d.id = s.deal_id
  LEFT JOIN public.profiles p ON p.user_id = s.owner_id
  WHERE s.token = _token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_share_token(text) TO anon, authenticated;

-- Accept a share token: insert deal_share_access row for caller
CREATE OR REPLACE FUNCTION public.accept_share_token(_token text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _share public.deal_shares;
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO _share FROM public.deal_shares WHERE token = _token LIMIT 1;
  IF _share.id IS NULL THEN
    RAISE EXCEPTION 'Invalid share link';
  END IF;
  IF _share.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Share link has been revoked';
  END IF;
  IF _share.owner_id = _uid THEN
    RETURN _share.deal_id;
  END IF;

  INSERT INTO public.deal_share_access (deal_id, user_id, share_id, owner_id, permission)
  VALUES (_share.deal_id, _uid, _share.id, _share.owner_id, _share.permission)
  ON CONFLICT (deal_id, user_id) DO UPDATE
    SET revoked_at = NULL, share_id = EXCLUDED.share_id, permission = EXCLUDED.permission;

  RETURN _share.deal_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_share_token(text) TO authenticated;