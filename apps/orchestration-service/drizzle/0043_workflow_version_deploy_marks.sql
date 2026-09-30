-- D1 notifications, deployment changed: the engine kept no time for when a
-- version went live, so nothing could tell a workflow's owners that it
-- changed. Promote stamps the version it makes live with 'promoted'; a
-- rollback stamps the version it restores with 'restored'. The platform's
-- scheduled pass reads recent stamps through a system-only feed.
ALTER TABLE "workflow_versions" ADD COLUMN "last_deployed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "last_deploy_kind" text;
--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_last_deploy_kind_check"
  CHECK ("last_deploy_kind" IS NULL OR "last_deploy_kind" IN ('promoted', 'restored'));
--> statement-breakpoint
CREATE INDEX "idx_workflow_versions_tenant_last_deployed" ON "workflow_versions" ("tenant_id", "last_deployed_at")
  WHERE "last_deployed_at" IS NOT NULL;
