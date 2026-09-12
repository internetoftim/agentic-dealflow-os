-- Concurrency hardening: the columns the dashboard filters and joins on were
-- unindexed, so every poll (per open tab) and every RLS check sequentially
-- scanned deals / sources / deal_people / capture_jobs. Cheap now, decisive
-- as users and deals grow.
CREATE INDEX IF NOT EXISTS idx_deals_user_created ON public.deals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_user_status ON public.deals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sources_deal ON public.sources(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_people_deal ON public.deal_people(deal_id);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_deal ON public.capture_jobs(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_members_user_team ON public.team_members(user_id, team_id);
