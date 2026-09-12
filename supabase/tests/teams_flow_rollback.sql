-- Live functional test of the teams flow: create → inherit → join → access →
-- one-team guard → leave → revoke. Runs as ONE transaction and always ends in
-- RAISE EXCEPTION, so it never persists data; the verdict is in the message.
--
--   supabase db query --linked --file supabase/tests/teams_flow_rollback.sql
--
-- Expect: ROLLBACK_TEST_OK inherit=true access_before=f access_after=t roster=2 dup_guard=enforced members_after_leave=1DO $$
DECLARE
  a uuid; b uuid;
  t public.teams; d_id uuid; d_team uuid;
  access_before boolean; access_after boolean; roster_n int; members_after int; dup_guard text := 'missing';
BEGIN
  -- any two real users not currently in a team
  SELECT p.user_id INTO a FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.team_members m WHERE m.user_id = p.user_id) ORDER BY p.created_at LIMIT 1;
  SELECT p.user_id INTO b FROM public.profiles p WHERE p.user_id <> a AND NOT EXISTS (SELECT 1 FROM public.team_members m WHERE m.user_id = p.user_id) ORDER BY p.created_at LIMIT 1;
  IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'Need two users without a team to run this test'; END IF;
  -- act as A: create team, then create a deal and check it inherits the team
  PERFORM set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', a::text, true);
  t := public.create_team('RollbackTest');
  INSERT INTO public.deals (user_id, name, stage, sector, source, status)
    VALUES (a, 'RollbackTest Deal', 'Seed', 'Test', 'manual', 'inbox')
    RETURNING id, team_id INTO d_id, d_team;
  IF d_team IS DISTINCT FROM t.id THEN RAISE EXCEPTION 'FAIL inheritance: got % expected %', d_team, t.id; END IF;

  access_before := public.can_access_deal(d_id, b);
  IF access_before THEN RAISE EXCEPTION 'FAIL: B could access before joining'; END IF;

  -- act as B: join via invite code, gain access, appear on roster
  PERFORM set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', b::text, true);
  PERFORM public.join_team(t.invite_code);
  access_after := public.can_access_deal(d_id, b);
  IF NOT access_after THEN RAISE EXCEPTION 'FAIL: B cannot access after joining'; END IF;
  SELECT count(*) INTO roster_n FROM public.get_team_roster();
  IF roster_n <> 2 THEN RAISE EXCEPTION 'FAIL roster size %', roster_n; END IF;

  -- one-team-per-user guard
  BEGIN
    PERFORM public.join_team(t.invite_code);
    dup_guard := 'NOT enforced';
  EXCEPTION WHEN OTHERS THEN
    dup_guard := CASE WHEN SQLERRM LIKE 'You are already in a team%' THEN 'enforced' ELSE 'wrong error: ' || SQLERRM END;
  END;

  -- B leaves: access revoked
  PERFORM public.leave_team();
  IF public.can_access_deal(d_id, b) THEN RAISE EXCEPTION 'FAIL: B still has access after leaving'; END IF;
  SELECT count(*) INTO members_after FROM public.team_members WHERE team_id = t.id;

  RAISE EXCEPTION 'ROLLBACK_TEST_OK inherit=true access_before=% access_after=% roster=% dup_guard=% members_after_leave=%',
    access_before, access_after, roster_n, dup_guard, members_after;
END $$;
