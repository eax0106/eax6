-- Admin console, billing operations (task B2.2).
--
-- A tenant whose payments failed is moved out of 'active' by the billing
-- webhook (billing_dunning_states, migration 0007). That table is tenant-RLS,
-- so the staff queue reads it through a SECURITY DEFINER function owned by
-- platform_provisioner, the same pattern as admin_list_users().
--
-- Rollback: DROP FUNCTION admin_list_billing_issues();
--           REVOKE SELECT ON billing_dunning_states FROM platform_provisioner;
GRANT SELECT ON "billing_dunning_states" TO platform_provisioner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_list_billing_issues()
RETURNS TABLE (
  "tenant_id" uuid,
  "tenant_name" text,
  "state" text,
  "current_plan" text,
  "first_failed_at" timestamptz,
  "updated_at" timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
SET row_security TO off
AS $$
  SELECT d.tenant_id, t.name, d.state, d.current_plan, d.first_failed_at, d.updated_at
    FROM billing_dunning_states d
    JOIN tenants t ON t.id = d.tenant_id
   WHERE d.state <> 'active'
   ORDER BY COALESCE(d.first_failed_at, d.updated_at) DESC
   LIMIT 500;
$$;
--> statement-breakpoint
ALTER FUNCTION admin_list_billing_issues() OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_list_billing_issues() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_billing_issues() TO platform_api;
