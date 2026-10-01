-- Content destruction cannot be reversed by DDL. Refuse rollback after a
-- seal or minimisation; restoring that state requires its matching backup
-- and signing key, not fabricated content or a genesis reset.
DO $$ BEGIN
  PERFORM set_config('app.audit_internal', 'on', true);
  IF EXISTS (SELECT 1 FROM audit_events WHERE erased_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM audit_chain_checkpoints WHERE signature IS NOT NULL) THEN
    RAISE EXCEPTION 'Sealed audit history requires matched backup recovery';
  END IF;
END; $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS minimise_audit_tenant(uuid, text, bigint, bytea);
--> statement-breakpoint
DROP FUNCTION IF EXISTS expire_audit_skeletons(timestamptz, bytea, bigint);
--> statement-breakpoint
ALTER TABLE audit_chain_checkpoints DROP COLUMN IF EXISTS last_position;
--> statement-breakpoint
ALTER TABLE audit_events DROP COLUMN IF EXISTS chain_position;
--> statement-breakpoint
DROP SEQUENCE IF EXISTS audit_chain_position_seq;
CREATE OR REPLACE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_events is immutable'; END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_immutable ON "audit_events";
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
--> statement-breakpoint
ALTER TABLE "audit_chain_checkpoints" DROP COLUMN IF EXISTS "signature";
--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN IF EXISTS "erased_at";
--> statement-breakpoint
ALTER TABLE audit_events ALTER COLUMN actor_ref SET NOT NULL;
--> statement-breakpoint
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_support_reason_check;
--> statement-breakpoint
ALTER TABLE audit_events ADD CONSTRAINT audit_events_support_reason_check CHECK (
  NOT (actor_type = 'support' OR lower(action) LIKE 'support.access%'
    OR position('break_glass' IN lower(action)) > 0 OR position('break-glass' IN lower(action)) > 0)
  OR nullif(btrim(reason_code), '') IS NOT NULL
);
