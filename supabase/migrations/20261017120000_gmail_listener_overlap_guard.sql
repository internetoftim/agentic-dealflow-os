-- Make the one-minute gmail-listener cron (cron job 1) safe when the database
-- or the function is slow.
--
-- Since 2026-10-12 pg_cron has logged hundreds of "cron job 1 job startup
-- timeout" per day, always while checkpoints were slow, and during the
-- 2026-10-16/17 freeze every tick still queued a net.http_post that took
-- 20-224 seconds. Findings from production, each addressed below:
--
--   1. Runs stacked up. A lease row (public.cron_leases) now serialises them:
--      the edge function claims it on entry with a TTL and releases it on
--      exit; while it is held the SQL tick skips the HTTP call and the
--      function answers "skipped" if invoked anyway.
--   2. cron.job_run_details was 649 MB of a 686 MB database (173k rows, two
--      JWTs in every command). It is pruned once here and daily from now on.
--   3. The pg_net call waited on a slow function. The tick now caps the wait
--      at 5 s explicitly; a timed-out request does not stop the function.
--   4. The cron authenticated with the anon key and the polling path checked
--      nothing. The tick now sends the service-role key from Vault and the
--      function rejects other callers (see gmail-listener/index.ts).
--   5. A one-minute cadence is only needed for queue healing. Mail polling
--      is asked for every other minute (body.pollMail); the function still
--      heals queues and Drive access on every tick.
--
-- Backward compatible: the job keeps its name, id and schedule; the function
-- runs unguarded (as before) until this migration is applied.
--
-- BEFORE APPLYING: store the service-role key in Vault, as the Supabase
-- account in org vcagent:
--   SELECT vault.create_secret('<service_role_key>', 'gmail_listener_service_key');
-- This migration refuses to run without it, so the cron can never fall back
-- to a key the function would reject.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'gmail_listener_service_key') THEN
    RAISE EXCEPTION 'Vault secret gmail_listener_service_key is missing: run SELECT vault.create_secret(''<service_role_key>'', ''gmail_listener_service_key'') first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.cron_leases (
  name text PRIMARY KEY,
  locked_until timestamptz NOT NULL DEFAULT '-infinity',
  locked_at timestamptz,
  released_at timestamptz,
  runs bigint NOT NULL DEFAULT 0,
  skips bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.cron_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_leases FROM public, anon, authenticated;
INSERT INTO public.cron_leases (name) VALUES ('gmail-listener') ON CONFLICT (name) DO NOTHING;

-- Claim a lease for _ttl_seconds. Returns true when claimed; false while a
-- previous holder's lease is still live. Atomic: one UPDATE, no read-then-write.
CREATE OR REPLACE FUNCTION public.claim_cron_lease(_name text, _ttl_seconds int DEFAULT 180)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _claimed boolean;
BEGIN
  INSERT INTO public.cron_leases AS l (name, locked_until, locked_at, runs)
  VALUES (_name, now() + make_interval(secs => _ttl_seconds), now(), 1)
  ON CONFLICT (name) DO UPDATE
    SET locked_until = EXCLUDED.locked_until, locked_at = EXCLUDED.locked_at, runs = l.runs + 1
    WHERE l.locked_until <= now();
  GET DIAGNOSTICS _claimed = ROW_COUNT;
  IF NOT _claimed THEN
    UPDATE public.cron_leases SET skips = skips + 1 WHERE name = _name;
  END IF;
  RETURN _claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_cron_lease(_name text)
RETURNS void
LANGUAGE sql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.cron_leases SET locked_until = now(), released_at = now() WHERE name = _name;
$$;

REVOKE ALL ON FUNCTION public.claim_cron_lease(text, int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_cron_lease(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_cron_lease(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_cron_lease(text) TO service_role;

-- The cron tick. Skips while the previous run still holds the lease, serialises
-- itself with an advisory lock, authenticates as the service role, and never
-- waits more than 5s on the HTTP call. The function may legitimately run
-- longer than that: a timed-out request does not stop it, it only stops the
-- database from waiting on it. Mail polling is requested every other minute;
-- queue healing and Drive access reconciliation happen on every tick.
CREATE OR REPLACE FUNCTION public.gmail_listener_tick()
RETURNS void
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _key text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('gmail-listener-tick')) THEN
    RETURN; -- another tick is dispatching right now
  END IF;
  IF EXISTS (SELECT 1 FROM public.cron_leases WHERE name = 'gmail-listener' AND locked_until > now()) THEN
    UPDATE public.cron_leases SET skips = skips + 1 WHERE name = 'gmail-listener';
    RETURN; -- previous run still in progress
  END IF;
  SELECT decrypted_secret INTO _key FROM vault.decrypted_secrets WHERE name = 'gmail_listener_service_key';
  IF _key IS NULL THEN
    RAISE WARNING 'gmail_listener_tick: Vault secret gmail_listener_service_key is missing; tick skipped';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/gmail-listener',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', _key,
      'Authorization', 'Bearer ' || _key
    ),
    body := jsonb_build_object(
      'trigger', 'cron',
      'time', now(),
      'pollMail', (extract(minute from now())::int % 2 = 0)
    ),
    timeout_milliseconds := 5000
  );
END;
$$;
REVOKE ALL ON FUNCTION public.gmail_listener_tick() FROM public, anon, authenticated;

-- Same job name and schedule as cron job 1: pg_cron updates it in place.
SELECT cron.schedule('gmail-listener-every-minute', '* * * * *', $$ SELECT public.gmail_listener_tick(); $$);

-- cron.job_run_details is never pruned by pg_cron. Keep a week; trim daily.
DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days';
SELECT cron.schedule('prune-cron-job-run-details', '17 3 * * *',
  $$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'; $$);

-- A Google refresh token that Google reports as invalid_grant (revoked or
-- expired) is dead: retrying it every minute only burns quota and log space.
-- The listener switches that user's Gmail auto-ingest off and records why, so
-- Settings can ask them to reconnect. Cleared when new tokens are stored.
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS google_connection_error text;
GRANT SELECT (google_connection_error) ON public.user_settings TO authenticated;
