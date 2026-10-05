DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM billing_admin_operations) OR EXISTS(SELECT 1 FROM billing_admin_credit_deliveries) THEN RAISE EXCEPTION 'Billing operations rollback requires retained history and pending delivery to be erased first';END IF;END $$;
--> statement-breakpoint
DROP FUNCTION erase_tenant_billing_admin_operations(uuid,text);
--> statement-breakpoint
DROP TABLE billing_admin_credit_deliveries,billing_admin_operations;
--> statement-breakpoint
DROP FUNCTION protect_billing_admin_history(),protect_billing_admin_delivery();
--> statement-breakpoint
DROP TRIGGER advance_billing_issue_revision ON billing_dunning_states;
--> statement-breakpoint
DROP FUNCTION advance_billing_issue_revision();
--> statement-breakpoint
DROP FUNCTION admin_list_staff_billing_issues();
--> statement-breakpoint
ALTER TABLE billing_dunning_states DROP COLUMN revision;
--> statement-breakpoint
