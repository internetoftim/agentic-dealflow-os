-- Agent Mode: opt-in, per-user write-capable MCP surface.
-- Purely additive. Default users (agent_mode_enabled = false) are unaffected.

-- 1) Per-user opt-in flag. Self-service: the existing user_settings RLS
--    (SELECT/INSERT/UPDATE where auth.uid() = user_id) already lets a user
--    toggle their own row, which is the intended "I want my agent to drive
--    EasyVC on my behalf" switch.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS agent_mode_enabled boolean NOT NULL DEFAULT false;

-- 2) deal_notes — durable append-many notes an agent (or the app) can write.
--    Append-many avoids read-modify-write races on a single TEXT column.
--    Modeled on public.deal_people.
CREATE TABLE IF NOT EXISTS public.deal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  body text NOT NULL,
  source text NOT NULL DEFAULT 'agent',   -- 'agent' | 'user'
  via text,                                -- 'pat' | 'oauth' | 'jwt' (audit hint)
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.deal_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own deal notes"
  ON public.deal_notes FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own deal notes"
  ON public.deal_notes FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own deal notes"
  ON public.deal_notes FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all deal notes"
  ON public.deal_notes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_deal_notes_deal ON public.deal_notes (deal_id, created_at DESC);

-- 3) mcp_tool_calls — audit log for write-tool invocations, and the backing
--    table for the per-user write rate limit (rolling-window count query).
--    Modeled on public.capture_jobs.
CREATE TABLE IF NOT EXISTS public.mcp_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tool text NOT NULL,
  args_hash text,        -- sha256 of the JSON args; never store raw args
  deal_id uuid,          -- nullable (e.g. create_deal has none up front)
  via text,              -- 'pat' | 'oauth'
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own mcp tool calls"
  ON public.mcp_tool_calls FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all mcp tool calls"
  ON public.mcp_tool_calls FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_user_time
  ON public.mcp_tool_calls (user_id, created_at DESC);
