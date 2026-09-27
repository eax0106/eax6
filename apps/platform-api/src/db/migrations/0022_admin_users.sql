-- Admin console, users (task B1.2).
--
-- users.status existed but nothing read it: a "suspended" user kept signing in.
-- The session store now only accepts sessions of active users (see
-- identity/session-store.ts); this migration makes the value set explicit and
-- adds what staff need to act on a user across tenants.
--
-- Rollback: DROP FUNCTION admin_revoke_user_sessions(uuid);
--           DROP FUNCTION admin_list_users(uuid);
--           DROP TABLE user_admin_actions;
--           ALTER TABLE users DROP CONSTRAINT users_status_known;
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_status_known";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_known" CHECK ("status" IN ('active', 'suspended'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_admin_actions" (
  "id" text PRIMARY KEY CHECK ("id" LIKE 'uaa\_%'),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "staff_user_id" text NOT NULL REFERENCES "staff_users"("id"),
  "action" text NOT NULL CHECK ("action" IN ('suspended', 'reinstated', 'sessions_revoked')),
  "reason" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_admin_actions_user_idx" ON "user_admin_actions" ("user_id", "occurred_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_user_admin_action_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'user_admin_actions is append-only'; END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_admin_actions_append_only ON "user_admin_actions";
--> statement-breakpoint
CREATE TRIGGER user_admin_actions_append_only
BEFORE UPDATE OR DELETE ON "user_admin_actions"
FOR EACH ROW EXECUTE FUNCTION prevent_user_admin_action_mutation();
--> statement-breakpoint
-- Cross-tenant by design (staff plane), same pattern as admin_list_tenants():
-- tenant_members and user_sessions are tenant-RLS tables, so the staff read
-- goes through a SECURITY DEFINER function owned by platform_provisioner.
-- NULL lists every user; a user id returns that one.
CREATE OR REPLACE FUNCTION admin_list_users(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  "id" uuid,
  "email" text,
  "display_name" text,
  "status" text,
  "created_at" timestamptz,
  "tenant_ids" uuid[],
  "last_seen_at" timestamptz,
  "active_sessions" integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
SET row_security TO off
AS $$
  SELECT u.id, u.email, u.display_name, u.status, u.created_at,
         COALESCE((SELECT array_agg(DISTINCT m.tenant_id) FROM tenant_members m WHERE m.user_id = u.id), '{}'),
         (SELECT max(s.last_seen_at) FROM user_sessions s WHERE s.user_id = u.id),
         (SELECT count(*)::integer FROM user_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL)
    FROM users u
   WHERE p_user_id IS NULL OR u.id = p_user_id
   ORDER BY u.created_at DESC
   LIMIT 500;
$$;
--> statement-breakpoint
ALTER FUNCTION admin_list_users(uuid) OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_list_users(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_users(uuid) TO platform_api;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "user_sessions" TO platform_provisioner;
--> statement-breakpoint
-- Revokes every live session of one user in every tenant; returns how many.
CREATE OR REPLACE FUNCTION admin_revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path FROM CURRENT
SET row_security TO off
AS $$
  WITH revoked AS (
    UPDATE user_sessions SET revoked_at = now()
     WHERE user_id = p_user_id AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer FROM revoked;
$$;
--> statement-breakpoint
ALTER FUNCTION admin_revoke_user_sessions(uuid) OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_revoke_user_sessions(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_revoke_user_sessions(uuid) TO platform_api;
