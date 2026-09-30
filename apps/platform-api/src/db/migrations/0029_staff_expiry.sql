-- Staff access, manifest and tombstone expiry (D2, Y1 narrow exception).
--
-- After a tenant is erased, its retained staff access records (SKELETON_TABLES
-- in retention-config.ts, kept SKELETON_RETENTION_DAYS = 90 days), its erasure
-- manifest and its tombstone may be deleted once 90 days past the tenant's
-- deleted_at, and only through the dedicated expiry function below: a
-- SECURITY DEFINER function owned by the dedicated platform_erasure role,
-- deleting only rows whose tenant tombstone is that old. A normal application
-- session still cannot delete them -- the guards prove it.
--
-- Mechanics, following 0026 exactly: the function sets the tenant context
-- itself (set_config, like erase_tenant_action_annotations) because the
-- tenants table is row-secured; manifests, skeleton rows and users carry no
-- row security. Row-security switches are deliberately NOT used: SET
-- row_security TO off in a definer function owned by a non-table-owner fails
-- closed ("would be affected by row-level security") instead of bypassing.
--
-- 1. The four skeleton tables keep append-only triggers, now conditional:
--    a DELETE passes only from a platform_erasure session for a tenant whose
--    tombstone is past the window (user_admin_actions joins through its user:
--    pseudonymised, untouched since the window, holding no membership
--    anywhere). UPDATE stays refused for everyone.
-- 2. Manifest and tombstone deletes pass only on the same path: nothing in
--    the application deletes them today (erasure tombstones by UPDATE), so the
--    guard changes no live flow.
-- 3. expire_erasure_skeleton() walks the manifests (the cross-tenant
--    discovery the sweep cannot do under row security), enforces the same
--    predicate per tenant, and counts what it removes. EXECUTE is granted to
--    platform_api (the migration pattern for definer functions); production's
--    platform_app reaches it through the EC2 roles script until security (b)
--    narrows the blanket function grant, which must carry this function over
--    explicitly.
--
-- Rollback: restore the unconditional guards from 0010 (jit_grant_audit),
--   0013 (tenant_admin_actions) and 0022 (user_admin_actions); drop the three
--   expiry guards; DROP FUNCTION expire_erasure_skeleton(timestamptz).
DO $role$
BEGIN
  BEGIN
    CREATE ROLE platform_erasure NOLOGIN NOSUPERUSER NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object THEN
    NULL; -- created by 0026 on a migrated database
  END;
END
$role$;
--> statement-breakpoint
-- Shared predicate for the guards below. Plain (like 0026's guard): it reads
-- the tenant row under the caller's own context, so a session without the
-- tenant set -- or with another tenant -- never sees a tombstone here.
CREATE OR REPLACE FUNCTION staff_expiry_allowed(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $body$
  SELECT EXISTS (
    SELECT 1 FROM tenants
     WHERE id = p_tenant
       AND status = 'deleted'
       AND deleted_at <= transaction_timestamp() - interval '90 days'
  )
$body$;
--> statement-breakpoint
-- tenant_admin_actions: DELETE only on the expiry path.
CREATE OR REPLACE FUNCTION prevent_tenant_admin_action_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'platform_erasure' AND staff_expiry_allowed(OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tenant_admin_actions is append-only';
END;
$$;
--> statement-breakpoint
-- jit_grants: DELETE only on the expiry path (revocation stays an UPDATE).
CREATE OR REPLACE FUNCTION prevent_jit_grant_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'platform_erasure' AND staff_expiry_allowed(OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'jit_grants cannot be deleted except on expiry';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jit_grants_expiry_only ON "jit_grants";
--> statement-breakpoint
CREATE TRIGGER jit_grants_expiry_only BEFORE DELETE ON "jit_grants" FOR EACH ROW EXECUTE FUNCTION prevent_jit_grant_deletion();
--> statement-breakpoint
-- jit_grant_audit: DELETE only on the expiry path, through its grant.
CREATE OR REPLACE FUNCTION prevent_jit_grant_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'platform_erasure' AND EXISTS (
    SELECT 1 FROM jit_grants g WHERE g.id = OLD.jit_grant_id AND staff_expiry_allowed(g.tenant_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'jit_grant_audit is append-only';
END;
$$;
--> statement-breakpoint
-- user_admin_actions: no tenant column, so the predicate joins through the
-- user. A row may go only from a platform_erasure session, when its user is
-- pseudonymised (the 'erased:' marker the erasure writer stamps), untouched
-- since the window, and holding no membership anywhere. A live user always
-- fails at least one of those, whatever the session's tenant context.
CREATE OR REPLACE FUNCTION prevent_user_admin_action_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'platform_erasure'
     AND NOT EXISTS (SELECT 1 FROM tenant_members m WHERE m.user_id = OLD.user_id)
     AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = OLD.user_id)
     AND EXISTS (
       SELECT 1 FROM users u
        WHERE u.id = OLD.user_id
          AND u.identity_ref LIKE 'erased:%'
          AND u.updated_at <= transaction_timestamp() - interval '90 days'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'user_admin_actions is append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_admin_actions_expiry_only ON "user_admin_actions";
--> statement-breakpoint
CREATE TRIGGER user_admin_actions_expiry_only BEFORE DELETE ON "user_admin_actions" FOR EACH ROW EXECUTE FUNCTION prevent_user_admin_action_deletion();
--> statement-breakpoint
-- The unconditional guard from 0022 would fire first on every DELETE; the
-- conditional trigger above replaces it for DELETEs, while UPDATE stays
-- refused through the original function re-hung as UPDATE-only.
DROP TRIGGER IF EXISTS user_admin_actions_append_only ON "user_admin_actions";
--> statement-breakpoint
CREATE TRIGGER user_admin_actions_append_only
BEFORE UPDATE ON "user_admin_actions"
FOR EACH ROW EXECUTE FUNCTION prevent_user_admin_action_mutation();
--> statement-breakpoint
-- Erasure manifests: DELETE only on the expiry path.
CREATE OR REPLACE FUNCTION prevent_erasure_manifest_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'platform_erasure' AND staff_expiry_allowed(OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tenant_erasure_manifests cannot be deleted except on expiry';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tenant_erasure_manifests_expiry_only ON "tenant_erasure_manifests";
--> statement-breakpoint
CREATE TRIGGER tenant_erasure_manifests_expiry_only BEFORE DELETE ON "tenant_erasure_manifests" FOR EACH ROW EXECUTE FUNCTION prevent_erasure_manifest_deletion();
--> statement-breakpoint
-- Tombstones: DELETE only on the expiry path. Nothing deletes tenant rows
-- today (erasure tombstones by UPDATE), so the guard changes no live flow.
CREATE OR REPLACE FUNCTION prevent_tenant_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'deleted' AND current_user = 'platform_erasure' AND staff_expiry_allowed(OLD.id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tenants cannot be deleted except on expiry';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tenants_expiry_only ON "tenants";
--> statement-breakpoint
CREATE TRIGGER tenants_expiry_only BEFORE DELETE ON "tenants" FOR EACH ROW EXECUTE FUNCTION prevent_tenant_deletion();
--> statement-breakpoint
-- The dedicated expiry path (Y1). Manifests are the cross-tenant discovery
-- the sweep cannot do under row security; each one names its tenant, the
-- function sets that tenant's context (0026 pattern), and every delete below
-- re-checks the window. A tenant with any non-complete manifest is skipped:
-- its erasure is still in flight and the manifest is its recovery record.
-- Tombstones without a manifest are left alone: the manifest is the erasure
-- record, and an expiry that cannot name its erasure refuses rather than
-- guesses.
DO $fn$
BEGIN
  EXECUTE format($def$
    CREATE OR REPLACE FUNCTION expire_erasure_skeleton(p_cutoff timestamptz) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $body$
    DECLARE
      tid uuid;
      tomb timestamptz;
      removed integer := 0;
      n integer;
    BEGIN
      FOR tid IN SELECT DISTINCT tenant_id FROM tenant_erasure_manifests LOOP
        PERFORM set_config('app.current_tenant_id', tid::text, true);
        SELECT deleted_at INTO tomb FROM tenants
         WHERE id = tid AND status = 'deleted' AND deleted_at <= p_cutoff
           AND NOT EXISTS (
             SELECT 1 FROM tenant_erasure_manifests m
              WHERE m.tenant_id = tid AND m.state <> 'complete'
           );
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
        DELETE FROM jit_grant_audit a USING jit_grants g
         WHERE a.jit_grant_id = g.id AND g.tenant_id = tid;
        GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
        DELETE FROM jit_grants WHERE tenant_id = tid;
        GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
        DELETE FROM tenant_admin_actions WHERE tenant_id = tid;
        GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
        DELETE FROM tenant_erasure_manifests WHERE tenant_id = tid;
        GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
        DELETE FROM tenants WHERE id = tid;
        GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
      END LOOP;
      PERFORM set_config('app.current_tenant_id', '', true);
      DELETE FROM user_admin_actions ua USING users u
       WHERE ua.user_id = u.id
         AND u.identity_ref LIKE 'erased:%%'
         AND u.updated_at <= p_cutoff
         AND NOT EXISTS (SELECT 1 FROM tenant_members m WHERE m.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id);
      GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
      RETURN removed;
    END;
    $body$
  $def$, current_schema());
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION expire_erasure_skeleton(timestamptz) OWNER TO platform_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION expire_erasure_skeleton(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION expire_erasure_skeleton(timestamptz) TO platform_api;
--> statement-breakpoint
-- The function runs as platform_erasure, so it needs its own privileges on
-- every table it touches (definer rights do not confer them). DELETE rights
-- stay safe: every delete below re-checks the 90-day tombstone predicate,
-- and the row guards refuse any other deleter.
GRANT SELECT, DELETE ON "tenants" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT, DELETE ON "tenant_admin_actions" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT, DELETE ON "jit_grants" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT, DELETE ON "jit_grant_audit" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT, DELETE ON "user_admin_actions" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT, DELETE ON "tenant_erasure_manifests" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT ON "users" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT ON "tenant_members" TO platform_erasure;
--> statement-breakpoint
GRANT SELECT ON "workspace_members" TO platform_erasure;
