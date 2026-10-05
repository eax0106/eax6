DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM deployment_admin_actions) THEN
    RAISE EXCEPTION 'cannot downgrade with retained deployment action history';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE deployment_admin_actions;
--> statement-breakpoint
DROP FUNCTION reject_deployment_action_update();
--> statement-breakpoint
DROP TRIGGER deployments_revision ON deployments;
--> statement-breakpoint
DROP FUNCTION advance_deployment_revision();
--> statement-breakpoint
ALTER TABLE deployments DROP COLUMN revision;
