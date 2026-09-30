-- Keep public webhook routing narrow without giving the application database
-- identity blanket access to tenant rows. The resolver can see only the one
-- endpoint named by its path token, and only its active secret reference.
-- Production initialization creates orchestration_service before migrations.
-- Testcontainers migrations run under a disposable owner without that role, so
-- retain the same predicate there while the SECURITY DEFINER owner is itself
-- the only executor.
DO $$
DECLARE
  policy_role text := CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orchestration_service')
    THEN '"orchestration_service"' ELSE 'PUBLIC' END;
BEGIN
  EXECUTE format(
    'CREATE POLICY "webhook_endpoints_public_resolver" ON "webhook_endpoints" FOR SELECT TO %s
     USING ("path_token" = NULLIF(current_setting(''app.webhook_path_token'', true), ''''))',
    policy_role
  );
  EXECUTE format(
    'CREATE POLICY "webhook_endpoint_secrets_public_resolver" ON "webhook_endpoint_secrets" FOR SELECT TO %s
     USING ("status" = ''active'' AND EXISTS (
       SELECT 1 FROM "webhook_endpoints" AS endpoint
       WHERE endpoint."tenant_id" = "webhook_endpoint_secrets"."tenant_id"
         AND endpoint."id" = "webhook_endpoint_secrets"."endpoint_id"
         AND endpoint."path_token" = NULLIF(current_setting(''app.webhook_path_token'', true), '''')
     ))',
    policy_role
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_webhook_endpoint(p_path_token text)
RETURNS TABLE (
  endpoint_id text,
  tenant_id uuid,
  workspace_id uuid,
  integration_id uuid,
  max_skew_seconds integer,
  secret_ref text,
  secret_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.webhook_path_token', p_path_token, true);
  RETURN QUERY
    SELECT endpoint.id, endpoint.tenant_id, endpoint.workspace_id, endpoint.integration_id,
           endpoint.max_skew_seconds, secret.secret_ref, secret.version
    FROM webhook_endpoints AS endpoint
    JOIN webhook_endpoint_secrets AS secret
      ON secret.tenant_id = endpoint.tenant_id
     AND secret.endpoint_id = endpoint.id
     AND secret.status = 'active'
    WHERE endpoint.path_token = p_path_token
    LIMIT 1;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_webhook_endpoint(text) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orchestration_service') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION resolve_webhook_endpoint(text) TO "orchestration_service"';
  END IF;
END;
$$;
