DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM abuse_signal_actions) OR EXISTS (SELECT 1 FROM abuse_signals WHERE assigned_to IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot downgrade with retained security review history';
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS erase_tenant_abuse_signal_actions(uuid,text);
--> statement-breakpoint
DROP TABLE abuse_signal_actions;
--> statement-breakpoint
ALTER TABLE abuse_signals DROP CONSTRAINT IF EXISTS abuse_signal_tenant_identity;
--> statement-breakpoint
DROP FUNCTION IF EXISTS protect_abuse_signal_actions();
--> statement-breakpoint
DROP TRIGGER IF EXISTS abuse_signal_revision ON abuse_signals;
--> statement-breakpoint
DROP FUNCTION IF EXISTS advance_abuse_signal_revision();
--> statement-breakpoint
ALTER TABLE abuse_signals DROP CONSTRAINT IF EXISTS abuse_signal_assignment_complete;
--> statement-breakpoint
ALTER TABLE abuse_signals DROP COLUMN assignment_reason, DROP COLUMN assigned_at, DROP COLUMN assigned_by, DROP COLUMN assigned_to, DROP COLUMN revision;
