ALTER TABLE public.deals 
ADD COLUMN IF NOT EXISTS linkedin_url text,
ADD COLUMN IF NOT EXISTS deep_research_status text NOT NULL DEFAULT 'pending';