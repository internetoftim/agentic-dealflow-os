-- GLM 5.3 via the NYO API becomes the default model.
-- Settings values prefixed "nyo-" are routed to https://llm.nyolab.ai/api/public/v1
-- by supabase/functions/_shared/ai-provider.ts (credential: NYO_API_KEY secret).
ALTER TABLE public.user_settings ALTER COLUMN ai_model SET DEFAULT 'nyo-glm-5.3';

-- Move workspaces still on a retired default onto the new one. Explicit choices
-- of a live model (gpt-5.4, gpt-5-mini, local-*) are left alone.
UPDATE public.user_settings
SET ai_model = 'nyo-glm-5.3'
WHERE ai_model IN ('gpt-oss-202b', 'gpt-4o', 'gpt-5');
