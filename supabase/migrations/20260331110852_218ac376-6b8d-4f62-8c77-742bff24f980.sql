
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS gmail_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS sources_gmail_dedup_idx 
  ON public.sources (user_id, gmail_message_id) 
  WHERE gmail_message_id IS NOT NULL;
