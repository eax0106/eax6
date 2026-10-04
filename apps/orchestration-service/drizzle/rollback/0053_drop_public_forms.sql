DROP POLICY IF EXISTS public_forms_version_scope ON trigger_versions;
--> statement-breakpoint
DROP POLICY IF EXISTS public_forms_trigger_scope ON triggers;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_surface') THEN
    EXECUTE 'REVOKE SELECT (id, tenant_id, workspace_id, type, provider, status) ON triggers FROM public_surface';
    EXECUTE 'REVOKE SELECT (id, tenant_id, trigger_id, version, config, status) ON trigger_versions FROM public_surface';
  END IF;
END;
$$;
