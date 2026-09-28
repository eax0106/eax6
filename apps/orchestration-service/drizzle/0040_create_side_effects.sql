-- Design log §4 / §22 item 7: the Side-Effect Ledger. Before a node that
-- acts on the outside world (sends, writes, deletes, submits) calls its
-- tool, the attempt is recorded; when the call returns, it is marked
-- completed. Recovery and the Executor's own retries consult this before
-- re-running the node, so a retry never sends the same message twice.
-- Kept apart from the Blackboard on purpose: these rows are evidence of
-- real external actions, not scratch context.
CREATE TABLE "side_effects" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "run_id" text NOT NULL,
  "dag_node_id" text NOT NULL,
  "node_execution_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "status" text NOT NULL,
  "tool_audit_id" text,
  "recorded_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "side_effects_status_check" CHECK ("status" IN ('attempted', 'completed')),
  CONSTRAINT "side_effects_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "side_effects_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "side_effects_node_execution_tenant_fk" FOREIGN KEY ("tenant_id", "node_execution_id") REFERENCES "node_executions"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER "side_effects_reject_tenant_id_change" BEFORE UPDATE ON "side_effects" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "side_effects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "side_effects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "side_effects_tenant_context_isolation" ON "side_effects"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE INDEX "idx_side_effects_run_node" ON "side_effects" ("tenant_id", "run_id", "dag_node_id");
