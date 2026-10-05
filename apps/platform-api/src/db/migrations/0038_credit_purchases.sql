CREATE TABLE IF NOT EXISTS credit_purchases (
  id text PRIMARY KEY CHECK(id ~ '^cpx_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id), actor_ref text NOT NULL,
  request_key text NOT NULL, request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  plan_id text NOT NULL, plan_version timestamptz NOT NULL,
  credits integer NOT NULL CHECK(credits BETWEEN 1 AND 1000000),
  unit_price_minor integer NOT NULL CHECK(unit_price_minor BETWEEN 1 AND 1000000000),
  credits_per_verified_run integer NOT NULL CHECK(credits_per_verified_run BETWEEN 1 AND 1000000000),
  base_price_minor integer NOT NULL, gst_minor integer NOT NULL, total_minor integer NOT NULL,
  gstin text, expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('submitting','checkout_ready','payment_pending','delivery_pending','delivered','cancelled','expired')),
  provider_ref text, checkout_url text, payment_ref text UNIQUE,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key),
  CHECK(base_price_minor = credits::bigint * unit_price_minor),
  CHECK(gst_minor = floor((base_price_minor::bigint * 18 + 50)::numeric / 100)),
  CHECK(total_minor = base_price_minor::bigint + gst_minor AND total_minor BETWEEN 100 AND 1000000000),
  CHECK((state IN ('delivery_pending','delivered')) = (payment_ref IS NOT NULL)),
  CHECK(payment_ref IS NULL OR payment_ref ~ '^pay_[A-Za-z0-9]{1,100}$'),
  CHECK(provider_ref IS NULL OR provider_ref ~ '^plink_[A-Za-z0-9]{1,100}$'),
  CHECK((provider_ref IS NULL) = (checkout_url IS NULL)),
  CHECK(gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_purchases_one_pending ON credit_purchases(tenant_id)
  WHERE state IN ('submitting','checkout_ready','payment_pending','delivery_pending');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_purchases_reconciliation_due ON credit_purchases(next_check_at,id)
  WHERE state IN ('submitting','checkout_ready','payment_pending','delivery_pending');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS credit_purchase_events (
  id text PRIMARY KEY CHECK(id ~ '^cpe_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  tenant_id uuid NOT NULL, purchase_id text NOT NULL, actor_type text NOT NULL CHECK(actor_type IN ('user','service')),
  actor_ref text NOT NULL, from_state text, to_state text NOT NULL, revision integer NOT NULL CHECK(revision > 0),
  audit_hash text NOT NULL CHECK(audit_hash ~ '^[0-9a-f]{64}$'), provider_event_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,purchase_id) REFERENCES credit_purchases(tenant_id,id), UNIQUE(tenant_id,purchase_id,revision)
);
--> statement-breakpoint
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['credit_purchases','credit_purchase_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('DROP POLICY IF EXISTS credit_purchase_read ON %I',target);
    EXECUTE format($p$CREATE POLICY credit_purchase_read ON %I FOR SELECT USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)$p$,target);
    EXECUTE format('DROP POLICY IF EXISTS credit_purchase_insert ON %I',target);
    EXECUTE format($p$CREATE POLICY credit_purchase_insert ON %I FOR INSERT WITH CHECK(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)$p$,target);
    EXECUTE format('DROP POLICY IF EXISTS credit_purchase_erasure ON %I',target);
    EXECUTE format($p$CREATE POLICY credit_purchase_erasure ON %I FOR DELETE TO platform_erasure USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)$p$,target);
  END LOOP;
END $$;
--> statement-breakpoint
DROP POLICY IF EXISTS credit_purchase_update ON credit_purchases;
--> statement-breakpoint
CREATE POLICY credit_purchase_update ON credit_purchases FOR UPDATE
  USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_credit_purchase() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN
    IF current_user='platform_erasure' AND EXISTS(SELECT 1 FROM tenant_erasure_manifests WHERE tenant_id=OLD.tenant_id AND state='active') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'credit purchase requires guarded erasure';
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.actor_ref,NEW.request_key,NEW.request_fingerprint,NEW.plan_id,NEW.plan_version,
    NEW.credits,NEW.unit_price_minor,NEW.credits_per_verified_run,NEW.base_price_minor,NEW.gst_minor,NEW.total_minor,
    NEW.gstin,NEW.expires_at,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id,OLD.tenant_id,OLD.actor_ref,OLD.request_key,OLD.request_fingerprint,OLD.plan_id,OLD.plan_version,
    OLD.credits,OLD.unit_price_minor,OLD.credits_per_verified_run,OLD.base_price_minor,OLD.gst_minor,OLD.total_minor,
    OLD.gstin,OLD.expires_at,OLD.created_at)
    OR (OLD.provider_ref IS NOT NULL AND ROW(NEW.provider_ref,NEW.checkout_url) IS DISTINCT FROM ROW(OLD.provider_ref,OLD.checkout_url))
    OR (OLD.payment_ref IS NOT NULL AND NEW.payment_ref IS DISTINCT FROM OLD.payment_ref)
  THEN RAISE EXCEPTION 'credit purchase snapshot and payment identity are immutable'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='submitting' AND NEW.state IN ('checkout_ready','payment_pending','delivery_pending','cancelled','expired'))
    OR (OLD.state='checkout_ready' AND NEW.state IN ('payment_pending','delivery_pending','cancelled','expired'))
    OR (OLD.state='payment_pending' AND NEW.state IN ('delivery_pending','cancelled','expired'))
    OR (OLD.state='delivery_pending' AND NEW.state='delivered'))
  THEN RAISE EXCEPTION 'credit purchase state cannot move backwards'; END IF;
  IF ROW(NEW.state,NEW.provider_ref,NEW.checkout_url,NEW.payment_ref) IS DISTINCT FROM ROW(OLD.state,OLD.provider_ref,OLD.checkout_url,OLD.payment_ref) THEN
    NEW.revision:=OLD.revision+1; NEW.updated_at:=GREATEST(clock_timestamp(),OLD.updated_at+interval '1 microsecond');
  ELSE NEW.revision:=OLD.revision;NEW.updated_at:=OLD.updated_at; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS protect_credit_purchase ON credit_purchases;
--> statement-breakpoint
CREATE TRIGGER protect_credit_purchase BEFORE UPDATE OR DELETE ON credit_purchases FOR EACH ROW EXECUTE FUNCTION protect_credit_purchase();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_credit_purchase_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' AND current_user='platform_erasure' AND EXISTS(SELECT 1 FROM tenant_erasure_manifests WHERE tenant_id=OLD.tenant_id AND state='active') THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'credit purchase events are append-only';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS protect_credit_purchase_events ON credit_purchase_events;
--> statement-breakpoint
CREATE TRIGGER protect_credit_purchase_events BEFORE UPDATE OR DELETE ON credit_purchase_events FOR EACH ROW EXECUTE FUNCTION protect_credit_purchase_events();
--> statement-breakpoint
GRANT SELECT,DELETE ON credit_purchases,credit_purchase_events TO platform_erasure;
--> statement-breakpoint
DO $fn$ BEGIN EXECUTE format($def$
  CREATE OR REPLACE FUNCTION erase_tenant_credit_purchases(p_tenant uuid,p_manifest text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=%I,pg_temp AS $body$
  DECLARE removed integer;total integer:=0;BEGIN
    IF NOT EXISTS(SELECT 1 FROM tenant_erasure_manifests WHERE tenant_id=p_tenant AND manifest_id=p_manifest AND state='active') THEN RAISE EXCEPTION 'no active erasure manifest for this tenant';END IF;
    PERFORM set_config('app.current_tenant_id',p_tenant::text,true);
    DELETE FROM credit_purchase_events WHERE tenant_id=p_tenant;GET DIAGNOSTICS removed=ROW_COUNT;total:=total+removed;
    DELETE FROM credit_purchases WHERE tenant_id=p_tenant;GET DIAGNOSTICS removed=ROW_COUNT;RETURN total+removed;
  END;$body$ $def$,current_schema());END $fn$;
--> statement-breakpoint
ALTER FUNCTION erase_tenant_credit_purchases(uuid,text) OWNER TO platform_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_tenant_credit_purchases(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION erase_tenant_credit_purchases(uuid,text) TO platform_api;
--> statement-breakpoint
GRANT SELECT ON credit_purchases TO platform_provisioner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION list_due_credit_purchases(batch_size integer) RETURNS TABLE(tenant_id uuid,purchase_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT SET row_security TO off AS $$
  SELECT p.tenant_id,p.id FROM credit_purchases p JOIN tenants t ON t.id=p.tenant_id
    WHERE p.state IN ('submitting','checkout_ready','payment_pending','delivery_pending') AND p.next_check_at<=clock_timestamp()
    AND t.deleted_at IS NULL AND t.status<>'deleted'
    ORDER BY p.next_check_at,p.id LIMIT LEAST(GREATEST(batch_size,1),100)
  $$;
--> statement-breakpoint
ALTER FUNCTION list_due_credit_purchases(integer) OWNER TO platform_provisioner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION list_due_credit_purchases(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION list_due_credit_purchases(integer) TO platform_api;
