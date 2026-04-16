ALTER TABLE public.sources
ADD COLUMN IF NOT EXISTS preview_images JSONB;
