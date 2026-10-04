DROP FUNCTION list_billing_sync_tenants(uuid,integer);
--> statement-breakpoint
DROP TABLE billing_credit_deliveries;
--> statement-breakpoint
DROP TABLE billing_policy_state;
--> statement-breakpoint
DROP TABLE billing_subscription_plans;
--> statement-breakpoint
ALTER TABLE billing_dunning_audits DROP COLUMN actor_ref;
--> statement-breakpoint
ALTER TABLE billing_profiles DROP COLUMN last_provider_event_at, DROP COLUMN provider_plan_ref,
  DROP COLUMN commercial_snapshot, DROP COLUMN gstin, DROP COLUMN checkout_attempt_id, DROP COLUMN checkout_started_at,
  DROP COLUMN mutation_attempt_id, DROP COLUMN mutation_kind, DROP COLUMN pending_plan,
  DROP COLUMN pending_provider_plan_ref, DROP COLUMN pending_commercial_snapshot;
--> statement-breakpoint
ALTER TABLE plan_definition_audit DROP COLUMN commercial;
--> statement-breakpoint
DROP INDEX plan_definitions_provider_plan_unique;
--> statement-breakpoint
ALTER TABLE plan_definitions DROP COLUMN commercial;
--> statement-breakpoint
DROP FUNCTION valid_plan_commercial(jsonb);
