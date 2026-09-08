-- Teams: multiple users share one dealflow. Deals inherit the creator's team.
-- Notes: collaborative annotations on a deal, visible to everyone who can see it.

-- ---------------------------------------------------------------- tables
CREATE TABLE public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL,
  invite_code text NOT NULL UNIQUE
    DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_team_members_user ON public.team_members(user_id);
CREATE INDEX idx_team_members_team ON public.team_members(team_id);

CREATE TABLE public.deal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  author_email text,
  content text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_notes ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_deal_notes_deal ON public.deal_notes(deal_id, created_at DESC);

CREATE TRIGGER deal_notes_set_updated_at
  BEFORE UPDATE ON public.deal_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_deals_team ON public.deals(team_id);

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION public.is_team_member(_team_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE team_id = _team_id AND user_id = _user_id
  );
$$;

-- Extend the existing access helper: own deal, explicitly shared, or same team.
-- Every "Shared users can view X" policy already routes through this function,
-- so sources / deal_people / capture_jobs visibility follows automatically.
CREATE OR REPLACE FUNCTION public.can_access_deal(_deal_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.deals WHERE id = _deal_id AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1 FROM public.deal_share_access
    WHERE deal_id = _deal_id AND user_id = _user_id AND revoked_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.deals d
    JOIN public.team_members tm ON tm.team_id = d.team_id
    WHERE d.id = _deal_id AND tm.user_id = _user_id
  );
$$;

-- ---------------------------------------------------------------- policies
CREATE POLICY "Members can view their teams"
  ON public.teams FOR SELECT TO authenticated
  USING (public.is_team_member(id, auth.uid()));
CREATE POLICY "Owner can update team"
  ON public.teams FOR UPDATE TO authenticated
  USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Service role manages teams"
  ON public.teams FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Members can view team roster"
  ON public.team_members FOR SELECT TO authenticated
  USING (public.is_team_member(team_id, auth.uid()));
CREATE POLICY "Service role manages team members"
  ON public.team_members FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Team members can view team deals"
  ON public.deals FOR SELECT TO authenticated
  USING (team_id IS NOT NULL AND public.is_team_member(team_id, auth.uid()));
CREATE POLICY "Team members can update team deals"
  ON public.deals FOR UPDATE TO authenticated
  USING (team_id IS NOT NULL AND public.is_team_member(team_id, auth.uid()))
  WITH CHECK (team_id IS NOT NULL AND public.is_team_member(team_id, auth.uid()));

CREATE POLICY "Deal viewers can read notes"
  ON public.deal_notes FOR SELECT TO authenticated
  USING (public.can_access_deal(deal_id, auth.uid()));
CREATE POLICY "Deal viewers can add notes"
  ON public.deal_notes FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.can_access_deal(deal_id, auth.uid()));
CREATE POLICY "Authors can update their notes"
  ON public.deal_notes FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Authors can delete their notes"
  ON public.deal_notes FOR DELETE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Service role manages notes"
  ON public.deal_notes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- inheritance
-- Every deal created by a team member lands in the team, regardless of the
-- ingestion path (app upload, public intake, Gmail, MCP agents).
CREATE OR REPLACE FUNCTION public.set_deal_team()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.team_id IS NULL THEN
    SELECT tm.team_id INTO NEW.team_id
    FROM public.team_members tm
    WHERE tm.user_id = NEW.user_id
    ORDER BY tm.created_at ASC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deals_set_team
  BEFORE INSERT ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.set_deal_team();

-- ---------------------------------------------------------------- RPCs
-- One team per user, enforced here. Existing solo deals are pulled into the
-- team on create/join so the shared dealflow is immediately populated.
CREATE OR REPLACE FUNCTION public.create_team(_name text)
RETURNS public.teams
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE t public.teams;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF length(trim(_name)) < 2 THEN RAISE EXCEPTION 'Team name must be at least 2 characters'; END IF;
  IF EXISTS (SELECT 1 FROM public.team_members WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You are already in a team. Leave it before creating a new one.';
  END IF;
  INSERT INTO public.teams (name, owner_id) VALUES (trim(_name), auth.uid()) RETURNING * INTO t;
  INSERT INTO public.team_members (team_id, user_id, role) VALUES (t.id, auth.uid(), 'owner');
  UPDATE public.deals SET team_id = t.id WHERE user_id = auth.uid() AND team_id IS NULL;
  RETURN t;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_team(_invite_code text)
RETURNS public.teams
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE t public.teams;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO t FROM public.teams WHERE invite_code = trim(_invite_code);
  IF t.id IS NULL THEN RAISE EXCEPTION 'Invalid invite code'; END IF;
  IF EXISTS (SELECT 1 FROM public.team_members WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'You are already in a team. Leave it before joining another.';
  END IF;
  INSERT INTO public.team_members (team_id, user_id, role) VALUES (t.id, auth.uid(), 'member');
  UPDATE public.deals SET team_id = t.id WHERE user_id = auth.uid() AND team_id IS NULL;
  RETURN t;
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_team()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _tid uuid; _role text; _others int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT team_id, role INTO _tid, _role FROM public.team_members WHERE user_id = auth.uid() LIMIT 1;
  IF _tid IS NULL THEN RAISE EXCEPTION 'You are not in a team'; END IF;
  SELECT count(*) INTO _others FROM public.team_members WHERE team_id = _tid AND user_id <> auth.uid();
  IF _role = 'owner' AND _others > 0 THEN
    RAISE EXCEPTION 'Remove other members before leaving a team you own';
  END IF;
  UPDATE public.deals SET team_id = NULL WHERE user_id = auth.uid() AND team_id = _tid;
  DELETE FROM public.team_members WHERE team_id = _tid AND user_id = auth.uid();
  IF _others = 0 THEN DELETE FROM public.teams WHERE id = _tid; END IF;
END;
$$;

-- Owner can remove a member (their deals drop back to personal space).
CREATE OR REPLACE FUNCTION public.remove_team_member(_member_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _tid uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT id INTO _tid FROM public.teams WHERE owner_id = auth.uid() LIMIT 1;
  IF _tid IS NULL THEN RAISE EXCEPTION 'Only the team owner can remove members'; END IF;
  IF _member_user_id = auth.uid() THEN RAISE EXCEPTION 'Use leave_team to leave your own team'; END IF;
  UPDATE public.deals SET team_id = NULL WHERE user_id = _member_user_id AND team_id = _tid;
  DELETE FROM public.team_members WHERE team_id = _tid AND user_id = _member_user_id;
END;
$$;

-- Roster with contact info, scoped to the caller's own team. Profiles stay
-- self-view-only; this exposes just identity fields for teammates.
CREATE OR REPLACE FUNCTION public.get_team_roster()
RETURNS TABLE (user_id uuid, role text, joined_at timestamptz, email text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tm.user_id, tm.role, tm.created_at, p.email, p.display_name
  FROM public.team_members tm
  LEFT JOIN public.profiles p ON p.user_id = tm.user_id
  WHERE tm.team_id IN (
    SELECT team_id FROM public.team_members WHERE user_id = auth.uid()
  )
  ORDER BY tm.created_at ASC;
$$;
GRANT EXECUTE ON FUNCTION public.get_team_roster() TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_team(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_team(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_team() TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_team_member(uuid) TO authenticated;

-- ---------------------------------------------------------------- realtime
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.deal_notes;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
