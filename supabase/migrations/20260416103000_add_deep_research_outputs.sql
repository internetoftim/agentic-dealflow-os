alter table public.deals
  add column if not exists research_verification jsonb,
  add column if not exists investor_research jsonb,
  add column if not exists latest_articles jsonb,
  add column if not exists deck_preview jsonb;
