ALTER TABLE deployments ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
--> statement-breakpoint
CREATE FUNCTION advance_deployment_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END;
$$;
--> statement-breakpoint
CREATE TRIGGER deployments_revision BEFORE UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION advance_deployment_revision();
--> statement-breakpoint
CREATE TABLE deployment_admin_actions (
  id text PRIMARY KEY CHECK (id ~ '^daa_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  tenant_id uuid NOT NULL,
  deployment_id text NOT NULL,
  actor_ref text NOT NULL CHECK (actor_ref ~ '^stf_[A-Za-z0-9._:-]{1,127}$'),
  action text NOT NULL CHECK (action IN ('rollback','suspend','resume')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  previous_status text NOT NULL,
  next_status text NOT NULL,
  active_deployment_id text,
  revision bigint NOT NULL CHECK (revision > 1),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,deployment_id,revision),
  CONSTRAINT deployment_admin_actions_00_subject_fk FOREIGN KEY (tenant_id,deployment_id) REFERENCES deployments(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT deployment_admin_actions_10_active_fk FOREIGN KEY (tenant_id,active_deployment_id) REFERENCES deployments(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((action='suspend' AND previous_status='active' AND next_status='suspended' AND active_deployment_id IS NULL)
      OR (action='resume' AND previous_status='suspended' AND next_status='active' AND active_deployment_id=deployment_id)
      OR (action='rollback' AND previous_status='active' AND next_status='rolled_back' AND active_deployment_id IS NOT NULL AND active_deployment_id<>deployment_id))
);
--> statement-breakpoint
CREATE INDEX deployment_admin_actions_tenant_idx ON deployment_admin_actions(tenant_id,deployment_id,revision DESC);
--> statement-breakpoint
ALTER TABLE deployment_admin_actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE deployment_admin_actions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deployment_admin_actions_read ON deployment_admin_actions FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY deployment_admin_actions_append ON deployment_admin_actions FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY deployment_admin_actions_delete ON deployment_admin_actions FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION reject_deployment_action_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'deployment action updates are not permitted'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER deployment_admin_actions_no_update BEFORE UPDATE ON deployment_admin_actions FOR EACH ROW EXECUTE FUNCTION reject_deployment_action_update();

--> statement-breakpoint
CREATE TRIGGER deployment_admin_actions_reject_tenant_id_change BEFORE UPDATE ON deployment_admin_actions FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
