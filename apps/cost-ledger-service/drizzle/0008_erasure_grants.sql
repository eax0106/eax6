-- Tenant erasure (D2, C3b): the provisioner role, which already nulls
-- billing_rollups.tenant_id and purges cost_events, also erases the tenant's
-- model outcomes and run verdicts. Delete only; nothing else is granted.
GRANT SELECT, DELETE ON "model_outcomes" TO cost_ledger_provisioner;
--> statement-breakpoint
GRANT SELECT, DELETE ON "run_verdicts" TO cost_ledger_provisioner;
