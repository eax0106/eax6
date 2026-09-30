DROP POLICY IF EXISTS "webhook_endpoint_secrets_public_resolver" ON "webhook_endpoint_secrets";
DROP POLICY IF EXISTS "webhook_endpoints_public_resolver" ON "webhook_endpoints";
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT endpoint.id, endpoint.tenant_id, endpoint.workspace_id, endpoint.integration_id,
         endpoint.max_skew_seconds, secret.secret_ref, secret.version
  FROM webhook_endpoints AS endpoint
  JOIN webhook_endpoint_secrets AS secret
    ON secret.tenant_id = endpoint.tenant_id
   AND secret.endpoint_id = endpoint.id
   AND secret.status = 'active'
  WHERE endpoint.path_token = p_path_token
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION resolve_webhook_endpoint(text) TO PUBLIC;
