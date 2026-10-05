ALTER TABLE tenant_admin_actions DROP CONSTRAINT IF EXISTS tenant_admin_actions_action_check;
--> statement-breakpoint
ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
  CHECK (action IN ('provisioned','suspended','reinstated','entitlement_overridden','note_added'));
--> statement-breakpoint
ALTER TABLE user_admin_actions DROP CONSTRAINT IF EXISTS user_admin_actions_action_check;
--> statement-breakpoint
ALTER TABLE user_admin_actions ADD CONSTRAINT user_admin_actions_action_check
  CHECK (action IN ('suspended','reinstated','sessions_revoked','note_added'));
--> statement-breakpoint
ALTER TABLE tenant_admin_actions DROP CONSTRAINT IF EXISTS tenant_admin_notes_body_check;
--> statement-breakpoint
ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_notes_body_check
  CHECK (action <> 'note_added' OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 4000));
--> statement-breakpoint
ALTER TABLE user_admin_actions DROP CONSTRAINT IF EXISTS user_admin_notes_body_check;
--> statement-breakpoint
ALTER TABLE user_admin_actions ADD CONSTRAINT user_admin_notes_body_check
  CHECK (action <> 'note_added' OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 4000));
