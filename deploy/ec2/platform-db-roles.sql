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
       set_config('alter.operations_password', :'operations_password', false);

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_operations') THEN
    CREATE ROLE platform_operations LOGIN;
  END IF;
  EXECUTE format('ALTER ROLE platform_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
                 current_setting('alter.app_password'));
  EXECUTE format('ALTER ROLE platform_operations LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L',
                 current_setting('alter.operations_password'));
END
$roles$;

-- Definer functions are granted to platform_api by the migrations; the app role
-- acts as platform_api for them.
DO $grants$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['platform_app', 'platform_operations'] LOOP
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), target);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', target);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', target);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', target);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', target);
  END LOOP;
END
$grants$;
