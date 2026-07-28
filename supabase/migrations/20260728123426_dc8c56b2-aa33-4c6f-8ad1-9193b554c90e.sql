CREATE TABLE public.conversion_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  source_url TEXT NOT NULL,
  company_name TEXT,
  website TEXT,
  linkedin_url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  pdf_storage_path TEXT,
  page_count INTEGER,
  title TEXT,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX conversion_jobs_email_idx ON public.conversion_jobs (lower(email));
CREATE INDEX conversion_jobs_status_idx ON public.conversion_jobs (status);

GRANT ALL ON public.conversion_jobs TO service_role;

ALTER TABLE public.conversion_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages conversion jobs"
  ON public.conversion_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER conversion_jobs_set_updated_at
  BEFORE UPDATE ON public.conversion_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

CREATE OR REPLACE FUNCTION public.get_conversion_job(_token TEXT, _email TEXT)
RETURNS TABLE (
  id UUID,
  token TEXT,
  email TEXT,
  source_url TEXT,
  company_name TEXT,
  website TEXT,
  linkedin_url TEXT,
  notes TEXT,
  status TEXT,
  error_message TEXT,
  pdf_storage_path TEXT,
  page_count INTEGER,
  title TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    j.id, j.token, j.email, j.source_url, j.company_name, j.website,
    j.linkedin_url, j.notes, j.status, j.error_message, j.pdf_storage_path,
    j.page_count, j.title, j.created_at, j.updated_at
  FROM public.conversion_jobs j
  WHERE j.token = _token
    AND lower(j.email) = lower(_email)
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_conversion_job(TEXT, TEXT) TO anon, authenticated;