ALTER TABLE billing_dunning_audits DROP COLUMN actor_ref;
--> statement-breakpoint
ALTER TABLE billing_profiles DROP COLUMN last_provider_event_at, DROP COLUMN provider_plan_ref,
  DROP COLUMN commercial_snapshot, DROP COLUMN gstin, DROP COLUMN checkout_attempt_id;
--> statement-breakpoint
ALTER TABLE plan_definition_audit DROP COLUMN commercial;
--> statement-breakpoint
DROP INDEX plan_definitions_provider_plan_unique;
--> statement-breakpoint
ALTER TABLE plan_definitions DROP COLUMN commercial;
--> statement-breakpoint
DROP FUNCTION valid_plan_commercial(jsonb);
