-- Runtime roles for platform_db on the single-EC2 host (task 6.1c).
--
-- The container's POSTGRES_USER (platform_api) is a superuser, and a superuser
-- bypasses row-level security even on FORCE ROW LEVEL SECURITY tables. It stays
-- the migration identity; the services connect as:
--   platform_app         the tenant plane: no superuser, no BYPASSRLS, so every
--                        tenant-RLS policy applies to it
--   platform_operations  the staff plane (OPERATIONS_*_DATABASE_URL): reads and
--                        acts across tenants by design, so BYPASSRLS
-- Both get data privileges only (no DDL, no ownership).
--
-- Run as the superuser with psql variables app_password and operations_password,
-- twice: before migrations (roles must exist for their GRANTs) and after them
-- (privileges on what they created). Idempotent.
SELECT set_config('alter.app_password', :'app_password', false),
       set_config('alter.retention_password', :'retention_password', false),
       set_config('alter.operations_password', :'operations_password', false);

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_operations') THEN
    CREATE ROLE platform_operations LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_retention') THEN
    CREATE ROLE platform_retention LOGIN;
  END IF;
  EXECUTE format('ALTER ROLE platform_retention LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
                 current_setting('alter.retention_password'));
  EXECUTE format('ALTER ROLE platform_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
                 current_setting('alter.app_password'));
  EXECUTE format('ALTER ROLE platform_operations LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
                 current_setting('alter.operations_password'));
END
$roles$;

-- Runtime function grants are explicit: signup uses the tenant plane and
-- administrative functions use the staff plane.
DO $grants$
DECLARE
  target text;
  signature text;
BEGIN
  FOREACH target IN ARRAY ARRAY['platform_app', 'platform_operations'] LOOP
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), target);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', target);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', target);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', target);
    FOREACH signature IN ARRAY CASE WHEN target = 'platform_app'
      THEN ARRAY['public.resolve_existing_signup(text,uuid)', 'public.resolve_workspace_invitation(text,text,text)', 'public.resolve_existing_organization_member(text,text)']
      ELSE ARRAY['public.admin_list_tenants()', 'public.admin_list_users(uuid)',
                 'public.admin_revoke_user_sessions(uuid)', 'public.admin_list_billing_issues()']
    END LOOP
      IF to_regprocedure(signature) IS NOT NULL THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', signature, target);
      END IF;
    END LOOP;
  END LOOP;
END
$grants$;

-- Retention has no direct table DML. Keep the expiry-only grant after the
-- existing runtime grants, including on the second post-migration run.
DO $retention$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO platform_retention', current_database());
  GRANT USAGE ON SCHEMA public TO platform_retention;
  IF to_regprocedure('public.expire_erasure_skeleton(timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.expire_erasure_skeleton(timestamptz) FROM PUBLIC, platform_app, platform_operations;
    GRANT EXECUTE ON FUNCTION public.expire_erasure_skeleton(timestamptz) TO platform_retention;
  END IF;
END
$retention$;
