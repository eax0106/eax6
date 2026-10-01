-- D13: recovery questions use the existing clarification queue, including
-- scheduled runs that have no conversation. Tenant isolation remains in force.
ALTER TABLE "clarifications" ALTER COLUMN "conversation_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "recovery_action_id" text;
--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "answer" text;
--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_source_check"
  CHECK ("conversation_id" IS NOT NULL OR "recovery_action_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_recovery_tenant_fk"
  FOREIGN KEY ("tenant_id", "recovery_action_id") REFERENCES "recovery_actions" ("tenant_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "clarifications_recovery_unique"
  ON "clarifications" ("tenant_id", "recovery_action_id");
