CREATE TABLE public.capture_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.capture_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own capture jobs"
  ON public.capture_jobs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own capture jobs"
  ON public.capture_jobs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role can manage all capture jobs"
  ON public.capture_jobs FOR ALL TO service_role
  USING (true) WITH CHECK (true);