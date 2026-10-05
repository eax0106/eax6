ALTER TABLE abuse_signals ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
--> statement-breakpoint
ALTER TABLE abuse_signals ADD COLUMN IF NOT EXISTS assigned_to text REFERENCES staff_users(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE abuse_signals ADD COLUMN IF NOT EXISTS assigned_by text REFERENCES staff_users(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE abuse_signals ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
--> statement-breakpoint
ALTER TABLE abuse_signals ADD COLUMN IF NOT EXISTS assignment_reason text;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='abuse_signal_assignment_complete' AND conrelid='abuse_signals'::regclass) THEN
    ALTER TABLE abuse_signals ADD CONSTRAINT abuse_signal_assignment_complete CHECK (
  (assigned_to IS NULL AND assigned_by IS NULL AND assigned_at IS NULL AND assignment_reason IS NULL)
  OR (assigned_to IS NOT NULL AND assigned_by IS NOT NULL AND assigned_at IS NOT NULL AND assignment_reason IS NOT NULL AND length(btrim(assignment_reason)) BETWEEN 1 AND 1000)
);
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION advance_abuse_signal_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS abuse_signal_revision ON abuse_signals;
CREATE TRIGGER abuse_signal_revision BEFORE UPDATE ON abuse_signals FOR EACH ROW EXECUTE FUNCTION advance_abuse_signal_revision();
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='abuse_signal_tenant_identity' AND conrelid='abuse_signals'::regclass) THEN
    ALTER TABLE abuse_signals ADD CONSTRAINT abuse_signal_tenant_identity UNIQUE(id,tenant_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS abuse_signal_actions (
  id text PRIMARY KEY CHECK (id ~ '^asa_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  signal_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('assign','confirm','dismiss')),
  actor_ref text NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  assignee_ref text REFERENCES staff_users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  revision bigint NOT NULL CHECK (revision > 1),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (action <> 'assign' OR assignee_ref IS NOT NULL),
  UNIQUE (signal_id, revision),
  FOREIGN KEY (signal_id,tenant_id) REFERENCES abuse_signals(id,tenant_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS abuse_signal_actions_tenant_idx ON abuse_signal_actions(tenant_id,signal_id,revision DESC);
--> statement-breakpoint
ALTER TABLE abuse_signal_actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE abuse_signal_actions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS abuse_signal_actions_read ON abuse_signal_actions;
CREATE POLICY abuse_signal_actions_read ON abuse_signal_actions FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS abuse_signal_actions_append ON abuse_signal_actions;
CREATE POLICY abuse_signal_actions_append ON abuse_signal_actions FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS abuse_signal_actions_erasure ON abuse_signal_actions;
CREATE POLICY abuse_signal_actions_erasure ON abuse_signal_actions FOR DELETE TO platform_erasure USING (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);
--> statement-breakpoint
GRANT SELECT,DELETE ON abuse_signal_actions TO platform_erasure;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_abuse_signal_actions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'platform_erasure' AND EXISTS (
    SELECT 1 FROM tenant_erasure_manifests WHERE tenant_id = OLD.tenant_id AND state = 'active'
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'abuse signal actions are append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS abuse_signal_actions_immutable ON abuse_signal_actions;
CREATE TRIGGER abuse_signal_actions_immutable BEFORE UPDATE OR DELETE ON abuse_signal_actions FOR EACH ROW EXECUTE FUNCTION protect_abuse_signal_actions();
--> statement-breakpoint
DO $fn$
BEGIN
  EXECUTE format($def$
    CREATE OR REPLACE FUNCTION erase_tenant_abuse_signal_actions(p_tenant uuid,p_manifest text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I,pg_temp AS $body$
    DECLARE removed integer;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM tenant_erasure_manifests WHERE manifest_id=p_manifest AND tenant_id=p_tenant AND state='active') THEN
        RAISE EXCEPTION 'no active erasure manifest for this tenant';
      END IF;
      PERFORM set_config('app.current_tenant_id',p_tenant::text,true);
      DELETE FROM abuse_signal_actions WHERE tenant_id=p_tenant;
      GET DIAGNOSTICS removed = ROW_COUNT;
      RETURN removed;
    END;
    $body$
  $def$,current_schema());
END;
$fn$;
--> statement-breakpoint
ALTER FUNCTION erase_tenant_abuse_signal_actions(uuid,text) OWNER TO platform_erasure;
--> statement-breakpoint
REVOKE ALL ON FUNCTION erase_tenant_abuse_signal_actions(uuid,text) FROM PUBLIC;
