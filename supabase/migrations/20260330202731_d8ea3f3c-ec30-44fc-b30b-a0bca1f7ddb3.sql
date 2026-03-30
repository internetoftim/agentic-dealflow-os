ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS crunchbase_url text,
  ADD COLUMN IF NOT EXISTS funding_total text,
  ADD COLUMN IF NOT EXISTS last_funding_round text,
  ADD COLUMN IF NOT EXISTS num_employees text;