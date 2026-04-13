
-- Add intake_slug column
ALTER TABLE public.user_settings
ADD COLUMN intake_slug text UNIQUE;

-- Create index for fast slug lookups
CREATE INDEX idx_user_settings_intake_slug ON public.user_settings (intake_slug) WHERE intake_slug IS NOT NULL;

-- Allow anon users to look up a slug (needed by the public intake page)
CREATE POLICY "Anyone can look up intake slug"
ON public.user_settings
FOR SELECT
TO anon
USING (intake_slug IS NOT NULL);
