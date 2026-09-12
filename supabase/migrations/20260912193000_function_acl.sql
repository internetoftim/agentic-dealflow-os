-- Functions get EXECUTE for PUBLIC by default, so a REVOKE ... FROM anon alone
-- is a no-op. Lock each internal helper down to exactly the roles that use it.
DO $$
DECLARE f text;
BEGIN
  -- Used inside RLS policies / RPCs by signed-in users; never by anonymous callers.
  FOREACH f IN ARRAY ARRAY[
    'public.can_access_deal(uuid, uuid)',
    'public.is_team_member(uuid, uuid)',
    'public.has_role(uuid, public.app_role)',
    'public.is_user_approved(uuid)',
    'public.get_team_roster()',
    'public.create_team(text)',
    'public.join_team(text)',
    'public.leave_team()',
    'public.remove_team_member(uuid)',
    'public.sync_my_profile(text, text, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;

  -- Trigger functions run as their owner; nobody calls them directly.
  FOREACH f IN ARRAY ARRAY['public.set_deal_team()', 'public.handle_new_auth_user()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;
