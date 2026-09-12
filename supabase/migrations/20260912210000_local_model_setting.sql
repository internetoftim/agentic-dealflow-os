-- Which in-browser model a user picked for the "Local — WebGPU" AI option.
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS local_model_id text;
-- Column-level grants are enumerated (see 20260912190000); extend them.
GRANT SELECT (local_model_id), INSERT (local_model_id), UPDATE (local_model_id) ON public.user_settings TO authenticated;
