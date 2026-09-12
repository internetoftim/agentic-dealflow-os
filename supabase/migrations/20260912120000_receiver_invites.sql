-- Invites let a workspace owner delegate the receiver-mailbox authorization to
-- whoever actually controls that mailbox. Single-use, expiring, revocable.

CREATE TABLE public.receiver_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  note text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.receiver_invites ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_receiver_invites_user ON public.receiver_invites(user_id);

-- Owners see and revoke their invites; only the OAuth function (service role)
-- creates or consumes them, and the raw token is never stored.
CREATE POLICY "Owners can view their invites"
  ON public.receiver_invites FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Owners can revoke their invites"
  ON public.receiver_invites FOR DELETE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Service role manages invites"
  ON public.receiver_invites FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.receiver_invites FROM anon;
REVOKE ALL ON public.receiver_invites FROM authenticated;
GRANT SELECT (id, user_id, note, expires_at, used_at, used_by_email, created_at)
  ON public.receiver_invites TO authenticated;
GRANT DELETE ON public.receiver_invites TO authenticated;
