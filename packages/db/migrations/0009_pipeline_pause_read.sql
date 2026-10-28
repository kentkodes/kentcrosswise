-- Fixed-purpose pause accessor: pipeline_rw must not read unrelated system flags.
CREATE FUNCTION public.pipeline_is_paused() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE((
    SELECT value IS DISTINCT FROM 'false'::jsonb
    FROM public.system_flags WHERE key = 'pipelines_paused'
  ), true);
$$;

REVOKE ALL ON FUNCTION public.pipeline_is_paused() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pipeline_is_paused() TO pipeline_rw;
