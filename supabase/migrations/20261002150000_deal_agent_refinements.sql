-- Conversational refinement of a deal's data room (the deal agent), with the
-- logging and versioning needed to learn from it later.
--
-- 1. research_exclusions / deal_people.manual — make refinements durable.
-- 2. pipeline_runs      — what each model run (extraction, research, memo) was
--                         given and produced, with its model and version.
-- 3. agent_turns        — every exchange with the deal agent: the state it saw,
--                         what it did, what it said, and the user's rating.
-- 4. deal_revisions     — a numbered, before/after record of every change, so
--                         changes can be undone and history is auditable.
-- 5. feedback_events    — human judgements on model output ("this article is
--                         not relevant", a corrected field, an undo, a thumbs
--                         down), each tied to the run that produced the item.
-- 6. rlhf_* views       — the above shaped as training/evaluation examples.
--
-- Rows are written only by edge functions (service role). Users can read their
-- own rows; nothing here is writable from the browser.

-- ------------------------------------------------------------------ 1. durability
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS research_exclusions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.deal_people
  ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------------ 2. pipeline runs
CREATE TABLE IF NOT EXISTS public.pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('extraction', 'research', 'memo')),
  version text NOT NULL,            -- code/prompt version of the stage, e.g. "extraction/2026-10-02"
  provider text,                    -- nyo | openai | sapinsapin | tavily | …
  model text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'unreadable', 'skipped')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,    -- what the stage was given (sizes, method, flags — not the full deck)
  output jsonb NOT NULL DEFAULT '{}'::jsonb,   -- what it produced (fields, articles, investors, people, …)
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,  -- chars, pages, counts, durations
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_deal ON public.pipeline_runs (deal_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user ON public.pipeline_runs (user_id, created_at DESC);

-- ------------------------------------------------------------------ 3. agent turns
CREATE TABLE IF NOT EXISTS public.agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  prompt_version text NOT NULL,
  provider text,
  model text,
  user_message text NOT NULL,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,     -- earlier messages of the conversation
  snapshot text NOT NULL DEFAULT '',              -- the deal state the model was shown
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ name, arguments, ok, summary, revision_id }]
  reply text,
  changed boolean NOT NULL DEFAULT false,
  steps integer NOT NULL DEFAULT 0,
  latency_ms integer,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,       -- token usage as reported by the provider
  error text,
  rating smallint CHECK (rating IN (-1, 1)),      -- explicit thumbs down / up
  rating_comment text,
  rated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_turns_deal ON public.agent_turns (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_turns_user ON public.agent_turns (user_id, created_at DESC);

-- ------------------------------------------------------------------ 4. revisions
CREATE TABLE IF NOT EXISTS public.deal_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 0,             -- 1, 2, 3 … per deal (assigned by trigger)
  turn_id uuid REFERENCES public.agent_turns(id) ON DELETE SET NULL,
  actor text NOT NULL DEFAULT 'agent' CHECK (actor IN ('agent', 'user', 'research', 'pipeline')),
  tool text NOT NULL,
  target text NOT NULL DEFAULT 'deal' CHECK (target IN ('deal', 'person', 'note')),
  target_id uuid,                                 -- deal_people.id / deal_notes.id when target is not the deal
  summary text NOT NULL,
  before jsonb NOT NULL DEFAULT '{}'::jsonb,      -- values before the change (only the keys that changed)
  after jsonb NOT NULL DEFAULT '{}'::jsonb,       -- values after the change
  reverts uuid REFERENCES public.deal_revisions(id) ON DELETE SET NULL,  -- set when this revision is an undo
  reverted_at timestamptz,                        -- set when a later revision undid this one
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deal_revisions_deal ON public.deal_revisions (deal_id, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_revisions_version ON public.deal_revisions (deal_id, version);

CREATE OR REPLACE FUNCTION public.deal_revisions_assign_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Serialise per deal so two concurrent changes cannot take the same number.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.deal_id::text));
  SELECT COALESCE(MAX(version), 0) + 1 INTO NEW.version FROM public.deal_revisions WHERE deal_id = NEW.deal_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_revisions_version ON public.deal_revisions;
CREATE TRIGGER trg_deal_revisions_version
  BEFORE INSERT ON public.deal_revisions
  FOR EACH ROW EXECUTE FUNCTION public.deal_revisions_assign_version();

-- ------------------------------------------------------------------ 5. feedback
CREATE TABLE IF NOT EXISTS public.feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  turn_id uuid REFERENCES public.agent_turns(id) ON DELETE SET NULL,
  revision_id uuid REFERENCES public.deal_revisions(id) ON DELETE SET NULL,
  -- What was judged.
  kind text NOT NULL CHECK (kind IN ('article', 'investor', 'person', 'field', 'memo', 'agent_turn', 'agent_action')),
  -- The judgement.
  label text NOT NULL CHECK (label IN ('irrelevant', 'relevant', 'corrected', 'added', 'thumbs_up', 'thumbs_down', 'reverted')),
  item jsonb NOT NULL DEFAULT '{}'::jsonb,        -- the thing judged, with enough context to learn from
  before jsonb,                                   -- the model's value (for corrections)
  after jsonb,                                    -- the human's value
  reason text,                                    -- in the user's words, when given
  context jsonb NOT NULL DEFAULT '{}'::jsonb,     -- deal name/sector/stage at the time
  -- Which run produced the judged item: stage, version, provider, model, run id.
  producer jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_events_deal ON public.feedback_events (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_events_kind ON public.feedback_events (kind, label, created_at DESC);

-- ------------------------------------------------------------------ access
ALTER TABLE public.pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipeline_runs', 'agent_turns', 'deal_revisions', 'feedback_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Owners can read their %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Owners can read their %1$s" ON public.%1$I FOR SELECT TO authenticated USING (auth.uid() = user_id)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ 6. dataset views
-- security_invoker: a user querying these sees only their own rows (RLS on the
-- base tables applies); the service role sees everything for export.

-- One row per agent turn: (state, instruction) → (actions, reply) with a reward.
-- Reward: explicit rating wins; otherwise an undo of any change in the turn is
-- negative, a turn whose changes all stood is weakly positive, and a turn with
-- failed actions is weakly negative.
CREATE OR REPLACE VIEW public.rlhf_agent_turns
WITH (security_invoker = true) AS
SELECT
  t.id AS turn_id,
  t.deal_id,
  t.user_id,
  t.created_at,
  t.prompt_version,
  t.provider,
  t.model,
  t.snapshot AS state,
  t.history,
  t.user_message AS instruction,
  t.tool_calls AS actions,
  t.reply,
  t.changed,
  t.rating,
  t.rating_comment,
  COALESCE(r.reverted, 0) AS reverted_changes,
  COALESCE(r.total, 0) AS total_changes,
  CASE
    WHEN t.rating IS NOT NULL THEN t.rating::numeric
    WHEN COALESCE(r.reverted, 0) > 0 THEN -1
    WHEN t.error IS NOT NULL THEN -0.5
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(t.tool_calls) c WHERE (c->>'ok')::boolean IS FALSE) THEN -0.25
    WHEN t.changed THEN 0.25
    ELSE 0
  END AS reward,
  CASE
    WHEN t.rating IS NOT NULL THEN 'explicit_rating'
    WHEN COALESCE(r.reverted, 0) > 0 THEN 'undo'
    WHEN t.error IS NOT NULL THEN 'error'
    ELSE 'implicit'
  END AS reward_source
FROM public.agent_turns t
LEFT JOIN LATERAL (
  SELECT count(*) AS total, count(*) FILTER (WHERE d.reverted_at IS NOT NULL) AS reverted
  FROM public.deal_revisions d
  WHERE d.turn_id = t.id AND d.reverts IS NULL
) r ON true;

-- One row per human judgement on a model-produced item: a labelled example for
-- relevance filtering and field extraction, attributable to model and version.
CREATE OR REPLACE VIEW public.rlhf_item_labels
WITH (security_invoker = true) AS
SELECT
  f.id AS feedback_id,
  f.deal_id,
  f.user_id,
  f.created_at,
  f.kind,
  f.label,
  f.item,
  f.before AS model_value,
  f.after AS human_value,
  f.reason,
  f.context,
  f.producer->>'stage' AS producer_stage,
  f.producer->>'version' AS producer_version,
  f.producer->>'provider' AS producer_provider,
  f.producer->>'model' AS producer_model,
  f.producer->>'run_id' AS producer_run_id
FROM public.feedback_events f;

GRANT SELECT ON public.rlhf_agent_turns, public.rlhf_item_labels TO authenticated;
GRANT SELECT ON public.rlhf_agent_turns, public.rlhf_item_labels TO service_role;
