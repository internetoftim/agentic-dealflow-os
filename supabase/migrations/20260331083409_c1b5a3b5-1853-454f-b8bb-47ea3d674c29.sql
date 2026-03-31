
CREATE TABLE public.deal_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  title text,
  linkedin_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.deal_people ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own deal people"
  ON public.deal_people FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own deal people"
  ON public.deal_people FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own deal people"
  ON public.deal_people FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all deal people"
  ON public.deal_people FOR ALL TO service_role
  USING (true) WITH CHECK (true);
