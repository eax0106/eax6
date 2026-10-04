-- Initialization provisions the dedicated runtime identity before migration.
-- Ordinary tenant policies remain in force; these predicates further restrict
-- the public process to the exact capability it has already authenticated.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_surface') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO public_surface';
    EXECUTE 'GRANT SELECT (id, tenant_id, workspace_id, type, provider, status) ON triggers TO public_surface';
    EXECUTE 'GRANT SELECT (id, tenant_id, trigger_id, version, config, status) ON trigger_versions TO public_surface';
    EXECUTE 'CREATE POLICY public_forms_trigger_scope ON triggers AS RESTRICTIVE FOR SELECT TO public_surface
      USING (type = ''webhook'' AND provider = ''alter_public_form''
        AND id = NULLIF(current_setting(''app.public_form_trigger_id'', true), ''''))';
    EXECUTE 'CREATE POLICY public_forms_version_scope ON trigger_versions AS RESTRICTIVE FOR SELECT TO public_surface
      USING (status = ''active'' AND config ? ''publicForm''
        AND id = NULLIF(current_setting(''app.public_form_version_id'', true), '''')
        AND trigger_id = NULLIF(current_setting(''app.public_form_trigger_id'', true), ''''))';
  END IF;
END;
$$;
