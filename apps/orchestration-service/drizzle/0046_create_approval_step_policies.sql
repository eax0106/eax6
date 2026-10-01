-- D5 approval modes. Every approval step has a mode set by a person with
-- approval rights: 'ask' (block until a person decides) or 'auto' (approve at
-- once; the run still records "approved by policy" and who set the mode).
-- Auto on a step guarding a side effect (email, database write, browser
-- click) needs an explicit confirmation of the named consequence, recorded
-- with who and when. Optional skip-on-timeout lets a run continue past an
-- unanswered approval, flagging the run. consecutive_approvals drives a
-- promotion suggestion after 10 approvals in a row; it is never applied
-- without a person.
CREATE TABLE "approval_step_policies" (
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "workflow_id" text NOT NULL,
  "node_key" text NOT NULL,
  "mode" text DEFAULT 'ask' NOT NULL,
  "side_effect_consequence" text,
  "auto_confirmed_by" text,
  "auto_confirmed_at" timestamptz,
  "skip_on_timeout" boolean DEFAULT false NOT NULL,
  "timeout_seconds" integer,
  "consecutive_approvals" integer DEFAULT 0 NOT NULL,
  "set_by" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "approval_step_policies_pkey" PRIMARY KEY ("tenant_id", "workflow_id", "node_key"),
  CONSTRAINT "approval_step_policies_workflow_fk" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflows"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "approval_step_policies_mode_check" CHECK ("mode" IN ('ask', 'auto')),
  CONSTRAINT "approval_step_policies_timeout_check" CHECK ("timeout_seconds" IS NULL OR "timeout_seconds" BETWEEN 60 AND 2592000),
  CONSTRAINT "approval_step_policies_skip_needs_window" CHECK (NOT "skip_on_timeout" OR "timeout_seconds" IS NOT NULL),
  CONSTRAINT "approval_step_policies_counter_check" CHECK ("consecutive_approvals" >= 0),
  CONSTRAINT "approval_step_policies_side_effect_confirmed" CHECK (
    "mode" = 'ask' OR "side_effect_consequence" IS NULL
    OR ("auto_confirmed_by" IS NOT NULL AND "auto_confirmed_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TRIGGER "approval_step_policies_reject_tenant_id_change" BEFORE UPDATE ON "approval_step_policies" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "approval_step_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "approval_step_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "approval_step_policies_tenant_context_isolation" ON "approval_step_policies"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
-- What the engine records on each approval: the mode used and who set it.
ALTER TABLE "approvals" ADD COLUMN "mode" text DEFAULT 'ask' NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "policy_set_by" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_mode_check" CHECK ("mode" IN ('ask', 'auto'));
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_status_check";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'skipped'));
--> statement-breakpoint
-- A run that went past an unanswered approval is flagged.
ALTER TABLE "runs" ADD COLUMN "flags" text[] DEFAULT '{}' NOT NULL;
