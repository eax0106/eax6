-- Tenant erasure (D2, C3b): payout_ledger stays append-only for every session
-- except one running as the dedicated role platform_erasure (only the
-- SECURITY DEFINER function below runs as it) and only while an active erasure
-- manifest names the row's tenant (platform migration 0026). A normal
-- application session cannot delete a row whatever tenant it has set. The
-- minimum fields the law says to keep are copied to legal_hold_records before
-- this runs. UPDATE stays refused.
GRANT SELECT, DELETE ON "payout_ledger" TO platform_erasure;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_payout_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'platform_erasure'
     AND EXISTS (
       SELECT 1 FROM tenant_erasure_manifests m
        WHERE m.tenant_id::text = OLD.tenant_id AND m.state = 'active'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'payout_ledger is append-only';
END;
$$;
--> statement-breakpoint
DO $fn$
BEGIN
  EXECUTE format($def$
    CREATE OR REPLACE FUNCTION erase_tenant_payout_ledger(p_tenant uuid, p_manifest text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $body$
    DECLARE
      removed integer;
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM tenant_erasure_manifests
         WHERE manifest_id = p_manifest AND tenant_id = p_tenant AND state = 'active'
      ) THEN
        RAISE EXCEPTION 'no active erasure manifest for this tenant';
      END IF;
      PERFORM set_config('app.current_tenant_id', p_tenant::text, true);
      DELETE FROM payout_ledger WHERE tenant_id = p_tenant::text;
      GET DIAGNOSTICS removed = ROW_COUNT;
      RETURN removed;
    END;
    $body$
  $def$, current_schema());
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION erase_tenant_payout_ledger(uuid, text) OWNER TO platform_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_tenant_payout_ledger(uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- Listings are shared across tenants: another tenant's order, install or review
-- may still point at a listing the erased tenant published, and that tenant's
-- session cannot see the other's rows. So this definer function (owned by the
-- migration identity, like the other cross-tenant functions) decides: a listing
-- something else still depends on is kept without an owner or content
-- (status removed), and any other listing is deleted with its versions. It only
-- runs for a tenant with an active erasure manifest.
DO $fn$
BEGIN
  EXECUTE format($def$
    CREATE OR REPLACE FUNCTION erase_tenant_listings(p_tenant uuid, p_manifest text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $body$
    DECLARE
      changed integer := 0;
      part integer;
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM tenant_erasure_manifests
         WHERE manifest_id = p_manifest AND tenant_id = p_tenant AND state = 'active'
      ) THEN
        RAISE EXCEPTION 'no active erasure manifest for this tenant';
      END IF;
      UPDATE listings l
         SET tenant_id = NULL, name = '[removed listing]', description = NULL, status = 'removed',
             price_minor = 0, updated_at = now()
       WHERE l.tenant_id = p_tenant::text
         AND (EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.tenant_id <> p_tenant::text)
           OR EXISTS (SELECT 1 FROM installs i WHERE i.listing_id = l.id AND i.tenant_id <> p_tenant::text)
           OR EXISTS (SELECT 1 FROM reviews r WHERE r.listing_id = l.id AND r.tenant_id <> p_tenant::text));
      GET DIAGNOSTICS part = ROW_COUNT;
      changed := changed + part;
      DELETE FROM listing_versions WHERE listing_id IN (SELECT id FROM listings WHERE tenant_id = p_tenant::text);
      GET DIAGNOSTICS part = ROW_COUNT;
      changed := changed + part;
      DELETE FROM listings WHERE tenant_id = p_tenant::text;
      GET DIAGNOSTICS part = ROW_COUNT;
      changed := changed + part;
      RETURN changed;
    END;
    $body$
  $def$, current_schema());
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_tenant_listings(uuid, text) FROM PUBLIC;
