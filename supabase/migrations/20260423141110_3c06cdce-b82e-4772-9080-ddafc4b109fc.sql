CREATE TYPE public.approval_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  approval_status public.approval_status NOT NULL DEFAULT 'pending',
  approval_requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  approved_at TIMESTAMP WITH TIME ZONE,
  approved_by UUID,
  rejected_at TIMESTAMP WITH TIME ZONE,
  rejected_by UUID,
  admin_notes TEXT,
  is_legacy_user BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_approval_status ON public.profiles (approval_status);
CREATE INDEX idx_profiles_email ON public.profiles (email);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  role public.app_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_user_approved(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE user_id = _user_id
      AND approval_status = 'approved'
  );
$$;

CREATE OR REPLACE FUNCTION public.sync_my_profile(_email TEXT, _display_name TEXT, _avatar_url TEXT)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _profile public.profiles;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO public.profiles (
    user_id,
    email,
    display_name,
    avatar_url,
    approval_status,
    approval_requested_at,
    last_seen_at
  )
  VALUES (
    _user_id,
    NULLIF(_email, ''),
    NULLIF(_display_name, ''),
    NULLIF(_avatar_url, ''),
    'pending',
    now(),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    email = COALESCE(NULLIF(EXCLUDED.email, ''), public.profiles.email),
    display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), public.profiles.display_name),
    avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), public.profiles.avatar_url),
    last_seen_at = now();

  SELECT *
  INTO _profile
  FROM public.profiles
  WHERE user_id = _user_id;

  RETURN _profile;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_my_profile(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_approved(UUID) TO authenticated;

CREATE POLICY "Users can view their own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update all profiles"
ON public.profiles
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can create profiles"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view their own roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can create roles"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete roles"
ON public.user_roles
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.profiles (
  user_id,
  approval_status,
  approval_requested_at,
  approved_at,
  is_legacy_user,
  last_seen_at
)
SELECT active_users.user_id,
       'approved'::public.approval_status,
       now(),
       now(),
       true,
       now()
FROM (
  SELECT user_id FROM public.deals
  UNION
  SELECT user_id FROM public.user_settings
  UNION
  SELECT user_id FROM public.sources
  UNION
  SELECT user_id FROM public.capture_jobs
  UNION
  SELECT user_id FROM public.deal_people
) AS active_users
ON CONFLICT (user_id) DO UPDATE
SET approval_status = 'approved',
    approved_at = COALESCE(public.profiles.approved_at, now()),
    is_legacy_user = true,
    last_seen_at = COALESCE(public.profiles.last_seen_at, now());