ALTER TABLE listings DROP CONSTRAINT listings_status_check;
--> statement-breakpoint
ALTER TABLE listings ADD CONSTRAINT listings_status_check CHECK (status IN (
  'draft','private_testing','submitted','automated_review','human_review','needs_changes',
  'published','suspended','deprecated','removed'));
--> statement-breakpoint
ALTER TABLE tool_manifests DROP CONSTRAINT tool_manifests_status_check;
--> statement-breakpoint
ALTER TABLE tool_manifests ADD CONSTRAINT tool_manifests_status_check
  CHECK (status IN ('draft','needs_changes','published','blocked'));
--> statement-breakpoint
ALTER TABLE listings ADD COLUMN governance_revision bigint NOT NULL DEFAULT 0 CHECK (governance_revision >= 0);
--> statement-breakpoint
ALTER TABLE tool_manifests ADD COLUMN governance_revision bigint NOT NULL DEFAULT 0 CHECK (governance_revision >= 0);
--> statement-breakpoint
CREATE FUNCTION advance_marketplace_governance_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.governance_revision := OLD.governance_revision + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER listings_governance_revision BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION advance_marketplace_governance_revision();
--> statement-breakpoint
CREATE TRIGGER tool_manifests_governance_revision BEFORE UPDATE ON tool_manifests
  FOR EACH ROW EXECUTE FUNCTION advance_marketplace_governance_revision();
--> statement-breakpoint
CREATE TABLE marketplace_governance_events (
  id text PRIMARY KEY CHECK (id ~ '^mge_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  tenant_id text,
  resource_type text NOT NULL CHECK (resource_type IN ('listing','tool_manifest')),
  resource_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('staff','seller')),
  actor_ref text NOT NULL CHECK (length(btrim(actor_ref)) BETWEEN 1 AND 255),
  action text NOT NULL CHECK (action IN ('approve','reject','needs_changes','takedown','restore','set_trust','resubmit','edit')),
  previous_status text NOT NULL,
  next_status text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  resource_revision bigint NOT NULL CHECK (resource_revision > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX marketplace_governance_resource_history ON marketplace_governance_events (resource_type,resource_id,occurred_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX marketplace_governance_tenant_actions ON marketplace_governance_events (tenant_id,action);
--> statement-breakpoint
ALTER TABLE marketplace_governance_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE marketplace_governance_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY marketplace_governance_owner_read ON marketplace_governance_events FOR SELECT
  USING (tenant_id = NULLIF(regexp_replace(current_setting('app.current_tenant_id',true),'^ten_',''),''));
--> statement-breakpoint
CREATE POLICY marketplace_governance_owner_insert ON marketplace_governance_events FOR INSERT
  WITH CHECK (tenant_id IS NOT NULL AND tenant_id = NULLIF(regexp_replace(current_setting('app.current_tenant_id',true),'^ten_',''),''));
--> statement-breakpoint
CREATE FUNCTION prevent_marketplace_governance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND current_user='platform_erasure' THEN
    IF EXISTS (SELECT 1 FROM tenant_erasure_manifests m WHERE m.tenant_id::text=OLD.tenant_id AND m.state='active') THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'marketplace_governance_events is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER marketplace_governance_append_only BEFORE UPDATE OR DELETE ON marketplace_governance_events
  FOR EACH ROW EXECUTE FUNCTION prevent_marketplace_governance_mutation();
--> statement-breakpoint
GRANT SELECT, DELETE ON marketplace_governance_events TO platform_erasure;
--> statement-breakpoint
CREATE POLICY marketplace_governance_erasure_delete ON marketplace_governance_events FOR DELETE TO platform_erasure
  USING (tenant_id=NULLIF(current_setting('app.current_tenant_id',true),''));
--> statement-breakpoint
DO $fn$ BEGIN
  EXECUTE format($def$
    CREATE FUNCTION erase_tenant_marketplace_governance(p_tenant uuid,p_manifest text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=%I,pg_temp AS $body$
    DECLARE removed integer;
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM tenant_erasure_manifests WHERE manifest_id=p_manifest AND tenant_id=p_tenant AND state='active') THEN
        RAISE EXCEPTION 'no active erasure manifest for this tenant';
      END IF;
      PERFORM set_config('app.current_tenant_id',p_tenant::text,true);
      DELETE FROM marketplace_governance_events WHERE tenant_id=p_tenant::text;
      GET DIAGNOSTICS removed=ROW_COUNT;
      RETURN removed;
    END;
    $body$
  $def$,current_schema());
END $fn$;
--> statement-breakpoint
ALTER FUNCTION erase_tenant_marketplace_governance(uuid,text) OWNER TO platform_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_tenant_marketplace_governance(uuid,text) FROM PUBLIC;
