-- Claude Managed Agents sessions for deck capture and deal diligence.
--
-- 1. deal_diligence_runs - one row per diligence session: status, the
--    structured report (founders, claims, market, competitors), the memo the
--    agent wrote, and what the run cost. Replaces deep-research when the
--    DILIGENCE_AGENT flag is on; deals.deep_research_status keeps tracking
--    progress so the existing UI works unchanged.
-- 2. agent_session_id on capture_jobs / conversion_jobs - the capture session
--    that is producing the PDF, so the webhook can find the job it belongs to.
--
-- Written only by edge functions (service role); owners can read their rows.
-- Backward compatible: nothing existing is renamed or required.

CREATE TABLE IF NOT EXISTS public.deal_diligence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  session_id text UNIQUE,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'running', 'collecting', 'completed', 'failed', 'budget_reached')),
  trigger text NOT NULL DEFAULT 'pipeline' CHECK (trigger IN ('pipeline', 'mcp', 'app')),
  version text NOT NULL,
  report jsonb,                 -- parsed diligence.json
  memo_md text,                 -- memo.md as the agent wrote it
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,   -- claim verdict counts, competitors, risks
  list_cost_cents integer,      -- session usage at list price, when known
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_deal_diligence_runs_deal ON public.deal_diligence_runs (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_diligence_runs_user ON public.deal_diligence_runs (user_id, created_at DESC);

ALTER TABLE public.deal_diligence_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners can read their deal_diligence_runs" ON public.deal_diligence_runs;
CREATE POLICY "Owners can read their deal_diligence_runs" ON public.deal_diligence_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
GRANT SELECT ON public.deal_diligence_runs TO authenticated;
GRANT ALL ON public.deal_diligence_runs TO service_role;

ALTER TABLE public.capture_jobs ADD COLUMN IF NOT EXISTS agent_session_id text;
ALTER TABLE public.conversion_jobs ADD COLUMN IF NOT EXISTS agent_session_id text;
CREATE INDEX IF NOT EXISTS idx_capture_jobs_agent_session ON public.capture_jobs (agent_session_id) WHERE agent_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversion_jobs_agent_session ON public.conversion_jobs (agent_session_id) WHERE agent_session_id IS NOT NULL;
