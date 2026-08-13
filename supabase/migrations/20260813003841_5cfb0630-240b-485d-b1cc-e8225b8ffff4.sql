ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS agent_mode_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.mcp_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tool_name text NOT NULL,
  deal_id uuid,
  arguments jsonb,
  success boolean NOT NULL DEFAULT true,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.mcp_tool_calls TO authenticated;
GRANT ALL ON public.mcp_tool_calls TO service_role;

ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own agent tool calls"
  ON public.mcp_tool_calls FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages agent tool calls"
  ON public.mcp_tool_calls FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS mcp_tool_calls_user_created_idx
  ON public.mcp_tool_calls (user_id, created_at DESC);