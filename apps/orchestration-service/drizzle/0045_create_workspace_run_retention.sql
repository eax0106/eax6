-- D2 run-history retention: a per-workspace setting, 7 to 365 days. The daily
-- retention sweep deletes a workspace's finished runs older than its setting
-- (365 days when no row exists), with their dependents through the existing
-- ON DELETE CASCADE foreign keys. Lowering the setting is confirmed by a
-- person who has seen how many runs it destroys.
CREATE TABLE "workspace_run_retention" (
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "retention_days" integer NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_run_retention_pkey" PRIMARY KEY ("tenant_id", "workspace_id"),
  CONSTRAINT "workspace_run_retention_days_range" CHECK ("retention_days" BETWEEN 7 AND 365)
);
--> statement-breakpoint
CREATE TRIGGER "workspace_run_retention_reject_tenant_id_change" BEFORE UPDATE ON "workspace_run_retention" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "workspace_run_retention" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_run_retention" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_run_retention_tenant_context_isolation" ON "workspace_run_retention"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
