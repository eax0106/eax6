DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_admin_actions WHERE action='note_added')
     OR EXISTS (SELECT 1 FROM user_admin_actions WHERE action='note_added') THEN
    RAISE EXCEPTION 'Admin notes rollback requires retained note history to expire first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE tenant_admin_actions DROP CONSTRAINT tenant_admin_notes_body_check;
--> statement-breakpoint
ALTER TABLE user_admin_actions DROP CONSTRAINT user_admin_notes_body_check;
--> statement-breakpoint
ALTER TABLE tenant_admin_actions DROP CONSTRAINT tenant_admin_actions_action_check;
--> statement-breakpoint
ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
  CHECK (action IN ('provisioned','suspended','reinstated','entitlement_overridden'));
--> statement-breakpoint
ALTER TABLE user_admin_actions DROP CONSTRAINT user_admin_actions_action_check;
--> statement-breakpoint
ALTER TABLE user_admin_actions ADD CONSTRAINT user_admin_actions_action_check
  CHECK (action IN ('suspended','reinstated','sessions_revoked'));
