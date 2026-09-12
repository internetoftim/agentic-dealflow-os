-- Ingestion ledger: one row per attachment (or per message when nothing was
-- usable), across every path — Gmail label, receiver inbox, public intake,
-- agents. It is the shared memory the Settings UI and MCP agents both read,
-- and it makes re-scans idempotent (processed Gmail messages are looked up
-- here instead of relying on read/unread state).

CREATE TABLE public.ingest_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  source_id uuid,
  channel text NOT NULL CHECK (channel IN ('label', 'receiver', 'intake', 'agent', 'manual')),
  receiver_account_id uuid REFERENCES public.receiver_accounts(id) ON DELETE SET NULL,
  gmail_message_id text,
  gmail_attachment_id text,
  sender text,
  subject text,
  file_name text,
  mime_type text,
  size_bytes bigint,
  content_hash text,
  outcome text NOT NULL CHECK (outcome IN ('uploaded', 'attached', 'duplicate', 'unsupported', 'skipped', 'failed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ingest_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_ingest_events_user_time ON public.ingest_events(user_id, created_at DESC);
CREATE INDEX idx_ingest_events_message ON public.ingest_events(receiver_account_id, gmail_message_id);
CREATE INDEX idx_ingest_events_user_message ON public.ingest_events(user_id, gmail_message_id);

CREATE POLICY "Owners can view their ingest events"
  ON public.ingest_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Service role manages ingest events"
  ON public.ingest_events FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.ingest_events FROM anon;

-- Content hash on sources enables duplicate detection across all paths.
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS content_hash text;
CREATE INDEX IF NOT EXISTS idx_sources_user_hash ON public.sources(user_id, content_hash) WHERE content_hash IS NOT NULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.ingest_events;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
