ALTER TABLE billing_dunning_states ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1 CHECK(revision>0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION advance_billing_issue_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.revision:=OLD.revision+1; RETURN NEW; END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS advance_billing_issue_revision ON billing_dunning_states;
--> statement-breakpoint
CREATE TRIGGER advance_billing_issue_revision BEFORE UPDATE ON billing_dunning_states FOR EACH ROW EXECUTE FUNCTION advance_billing_issue_revision();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS billing_admin_operations(
 id text PRIMARY KEY CHECK(id ~ '^bop_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 action text NOT NULL CHECK(action IN ('retry','resolve','grant_credits')),
 actor_ref text NOT NULL REFERENCES staff_users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 revision bigint NOT NULL CHECK(revision>1),
 runs integer CHECK(runs BETWEEN 1 AND 1000000),credits integer CHECK(credits BETWEEN 1 AND 1000000000),
 recovery_url text,subscription_ref text,invoice_ref text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,credits),UNIQUE(tenant_id,revision),
 CHECK((action='grant_credits' AND runs IS NOT NULL AND credits IS NOT NULL AND recovery_url IS NULL AND invoice_ref IS NULL) OR (action='retry' AND runs IS NULL AND credits IS NULL AND recovery_url IS NOT NULL AND subscription_ref IS NOT NULL AND invoice_ref IS NULL) OR (action='resolve' AND runs IS NULL AND credits IS NULL AND recovery_url IS NULL AND subscription_ref IS NOT NULL AND invoice_ref IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS billing_admin_credit_deliveries(
 tenant_id uuid NOT NULL REFERENCES tenants(id),operation_id text NOT NULL,
 credits integer NOT NULL CHECK(credits BETWEEN 1 AND 1000000000),
 published_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,operation_id),FOREIGN KEY(tenant_id,operation_id,credits) REFERENCES billing_admin_operations(tenant_id,id,credits)
);
--> statement-breakpoint
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['billing_admin_operations','billing_admin_credit_deliveries'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
  EXECUTE format('DROP POLICY IF EXISTS billing_admin_read ON %I',target);
  EXECUTE format($p$CREATE POLICY billing_admin_read ON %I FOR SELECT USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)$p$,target);
  EXECUTE format('DROP POLICY IF EXISTS billing_admin_append ON %I',target);
  EXECUTE format($p$CREATE POLICY billing_admin_append ON %I FOR INSERT WITH CHECK(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)$p$,target);
  EXECUTE format('DROP TRIGGER IF EXISTS billing_admin_tenant_immutable ON %I',target);
  EXECUTE format('CREATE TRIGGER billing_admin_tenant_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_tenant_id_update()',target);
 END LOOP;
END $$;
--> statement-breakpoint
DROP POLICY IF EXISTS billing_admin_delivery_update ON billing_admin_credit_deliveries;
--> statement-breakpoint
CREATE POLICY billing_admin_delivery_update ON billing_admin_credit_deliveries FOR UPDATE USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_billing_admin_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND current_user='platform_erasure' AND EXISTS(SELECT 1 FROM tenant_erasure_manifests WHERE tenant_id=OLD.tenant_id AND state='active') THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'billing admin history is append-only';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS protect_billing_admin_history ON billing_admin_operations;
--> statement-breakpoint
CREATE TRIGGER protect_billing_admin_history BEFORE UPDATE OR DELETE ON billing_admin_operations FOR EACH ROW EXECUTE FUNCTION protect_billing_admin_history();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_billing_admin_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.credits IS DISTINCT FROM OLD.credits OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.published_at IS NOT NULL THEN RAISE EXCEPTION 'billing credit delivery is immutable except its first acknowledgement';END IF;RETURN NEW;END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS protect_billing_admin_delivery ON billing_admin_credit_deliveries;
--> statement-breakpoint
CREATE TRIGGER protect_billing_admin_delivery BEFORE UPDATE ON billing_admin_credit_deliveries FOR EACH ROW EXECUTE FUNCTION protect_billing_admin_delivery();
--> statement-breakpoint
GRANT SELECT,DELETE ON billing_admin_operations,billing_admin_credit_deliveries TO platform_erasure;
--> statement-breakpoint
DROP POLICY IF EXISTS billing_admin_erasure ON billing_admin_operations;
--> statement-breakpoint
CREATE POLICY billing_admin_erasure ON billing_admin_operations FOR DELETE TO platform_erasure USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS billing_admin_erasure ON billing_admin_credit_deliveries;
--> statement-breakpoint
CREATE POLICY billing_admin_erasure ON billing_admin_credit_deliveries FOR DELETE TO platform_erasure USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
DO $fn$ BEGIN EXECUTE format($def$
 CREATE OR REPLACE FUNCTION erase_tenant_billing_admin_operations(p_tenant uuid,p_manifest text) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=%I,pg_temp AS $body$
 DECLARE removed integer;total integer:=0; BEGIN
 IF NOT EXISTS(SELECT 1 FROM tenant_erasure_manifests WHERE tenant_id=p_tenant AND manifest_id=p_manifest AND state='active') THEN RAISE EXCEPTION 'no active erasure manifest for this tenant';END IF;
 PERFORM set_config('app.current_tenant_id',p_tenant::text,true);
 DELETE FROM billing_admin_credit_deliveries WHERE tenant_id=p_tenant;GET DIAGNOSTICS removed=ROW_COUNT;total:=total+removed;
 DELETE FROM billing_admin_operations WHERE tenant_id=p_tenant;GET DIAGNOSTICS removed=ROW_COUNT;RETURN total+removed;
 END;$body$ $def$,current_schema()); END $fn$;
--> statement-breakpoint
ALTER FUNCTION erase_tenant_billing_admin_operations(uuid,text) OWNER TO platform_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_tenant_billing_admin_operations(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION erase_tenant_billing_admin_operations(uuid,text) TO platform_api;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_list_staff_billing_issues() RETURNS TABLE(tenant_id uuid,tenant_name text,state text,current_plan text,first_failed_at timestamptz,updated_at timestamptz,revision text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT SET row_security TO off AS $$
 SELECT d.tenant_id,t.name,d.state,d.current_plan,d.first_failed_at,d.updated_at,d.revision::text FROM billing_dunning_states d JOIN tenants t ON t.id=d.tenant_id
 WHERE d.state<>'active' AND t.status<>'deleted' AND t.deleted_at IS NULL ORDER BY COALESCE(d.first_failed_at,d.updated_at) DESC,d.tenant_id LIMIT 500 $$;
--> statement-breakpoint
ALTER FUNCTION admin_list_staff_billing_issues() OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_list_staff_billing_issues() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_staff_billing_issues() TO platform_api;
