DROP INDEX IF EXISTS "idx_workflow_versions_tenant_last_deployed";
ALTER TABLE "workflow_versions" DROP CONSTRAINT IF EXISTS "workflow_versions_last_deploy_kind_check";
ALTER TABLE "workflow_versions" DROP COLUMN IF EXISTS "last_deploy_kind";
ALTER TABLE "workflow_versions" DROP COLUMN IF EXISTS "last_deployed_at";
