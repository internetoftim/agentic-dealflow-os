-- Production hardening ahead of Google OAuth app verification.

-- 1. Google tokens never reach the browser. They are written by the
--    store-google-tokens function (encrypted) and read only by edge functions.
--    Clients keep full access to every other user_settings column.
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS google_scopes text;

REVOKE ALL ON public.user_settings FROM anon;
REVOKE ALL ON public.user_settings FROM authenticated;
GRANT SELECT (
  id, user_id, created_at, updated_at, ai_model, gmail_label_enabled, drive_sync_enabled,
  spam_filter_enabled, deep_research_provider, naming_pattern, naming_mode, drive_folder,
  memo_prompt, recap_naming_pattern, intake_slug, agent_mode_enabled, text_only_llm, google_scopes
) ON public.user_settings TO authenticated;
GRANT INSERT (
  id, user_id, created_at, updated_at, ai_model, gmail_label_enabled, drive_sync_enabled,
  spam_filter_enabled, deep_research_provider, naming_pattern, naming_mode, drive_folder,
  memo_prompt, recap_naming_pattern, intake_slug, agent_mode_enabled, text_only_llm
) ON public.user_settings TO authenticated;
GRANT UPDATE (
  updated_at, ai_model, gmail_label_enabled, drive_sync_enabled,
  spam_filter_enabled, deep_research_provider, naming_pattern, naming_mode, drive_folder,
  memo_prompt, recap_naming_pattern, intake_slug, agent_mode_enabled, text_only_llm
) ON public.user_settings TO authenticated;

-- 2. Internal SECURITY DEFINER helpers were executable by anonymous callers
--    (access probing / enumeration). Only the three share/convert landing
--    helpers are meant to be public.
REVOKE EXECUTE ON FUNCTION public.can_access_deal(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_team_member(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_user_approved(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_team_roster() FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_team(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.join_team(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.leave_team() FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_team_member(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_deal_team() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_my_profile(text, text, text) FROM anon;

-- 3. Every user gets a profile row at sign-up, and the approval gate the
--    login page promises ("invite-only, admin approval") becomes real:
--    approval_status is what ProtectedRoute checks. Existing users are
--    approved so nothing changes for them.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name, avatar_url, approval_status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url',
    'pending'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = COALESCE(public.profiles.display_name, EXCLUDED.display_name),
    avatar_url = COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Backfill: anyone who already has an account is approved.
INSERT INTO public.profiles (user_id, email, display_name, avatar_url, approval_status, approved_at, is_legacy_user)
SELECT u.id, u.email, u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'avatar_url', 'approved', now(), true
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id);
UPDATE public.profiles SET approval_status = 'approved', approved_at = COALESCE(approved_at, now())
WHERE approval_status = 'pending' AND created_at < now() - interval '1 minute';

-- Users may read their own approval state (existing policy) — nothing else changes.
