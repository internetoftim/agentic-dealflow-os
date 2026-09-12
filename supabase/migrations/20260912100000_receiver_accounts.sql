-- Receiver accounts: a second Gmail address connected purely as a deal inbox.
-- Every message it receives is scanned for a deck attachment (no label needed)
-- and ingested into the owner's workspace — and, via deals_set_team, their team.

CREATE TABLE public.receiver_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email text NOT NULL UNIQUE,
  google_access_token text,
  google_refresh_token text,
  gmail_history_id text,
  enabled boolean NOT NULL DEFAULT true,
  last_polled_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.receiver_accounts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_receiver_accounts_user ON public.receiver_accounts(user_id);
CREATE INDEX idx_receiver_accounts_enabled ON public.receiver_accounts(enabled) WHERE enabled;

CREATE TRIGGER receiver_accounts_set_updated_at
  BEFORE UPDATE ON public.receiver_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

-- Owners manage their own receivers; tokens are written only by the OAuth
-- function (service role) and are never readable from the client.
CREATE POLICY "Owners can view their receivers"
  ON public.receiver_accounts FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Owners can toggle their receivers"
  ON public.receiver_accounts FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Owners can disconnect their receivers"
  ON public.receiver_accounts FOR DELETE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Service role manages receivers"
  ON public.receiver_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Column-level lockdown: clients can read status, never credentials.
REVOKE ALL ON public.receiver_accounts FROM authenticated;
GRANT SELECT (id, user_id, email, enabled, last_polled_at, last_error, created_at, updated_at)
  ON public.receiver_accounts TO authenticated;
GRANT UPDATE (enabled) ON public.receiver_accounts TO authenticated;
GRANT DELETE ON public.receiver_accounts TO authenticated;
-- Anonymous clients get nothing at all (no policies target anon anyway).
REVOKE ALL ON public.receiver_accounts FROM anon;
