
-- Deals table
CREATE TABLE public.deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'Unknown',
  sector TEXT NOT NULL DEFAULT 'Unknown',
  source TEXT NOT NULL DEFAULT 'manual',
  auto_ingested BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'inbox',
  deck_size TEXT,
  compressed_size TEXT,
  pages INTEGER,
  website TEXT,
  website_searching BOOLEAN DEFAULT false,
  ask_amount TEXT,
  valuation TEXT,
  revenue TEXT,
  growth TEXT,
  nrr TEXT,
  team_size TEXT,
  memo_draft TEXT,
  gdrive_file_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sources table (individual uploaded files per deal)
CREATE TABLE public.sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID REFERENCES public.deals(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  file_name TEXT NOT NULL,
  original_size TEXT,
  compressed_size TEXT,
  storage_path TEXT,
  source_type TEXT NOT NULL DEFAULT 'upload',
  processing_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User settings table
CREATE TABLE public.user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  gmail_label_enabled BOOLEAN DEFAULT true,
  drive_sync_enabled BOOLEAN DEFAULT true,
  spam_filter_enabled BOOLEAN DEFAULT true,
  naming_mode TEXT DEFAULT 'auto',
  naming_pattern TEXT,
  google_provider_token TEXT,
  google_provider_refresh_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS policies for deals
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own deals"
  ON public.deals FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own deals"
  ON public.deals FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own deals"
  ON public.deals FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own deals"
  ON public.deals FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- RLS policies for sources
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own sources"
  ON public.sources FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own sources"
  ON public.sources FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sources"
  ON public.sources FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own sources"
  ON public.sources FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- RLS policies for user_settings
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own settings"
  ON public.user_settings FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own settings"
  ON public.user_settings FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own settings"
  ON public.user_settings FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Storage bucket for decks
INSERT INTO storage.buckets (id, name, public)
VALUES ('decks', 'decks', false);

-- Storage RLS: users can upload to their own folder
CREATE POLICY "Users can upload decks"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'decks' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can view their own decks"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'decks' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete their own decks"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'decks' AND (storage.foldername(name))[1] = auth.uid()::text);
