-- Workspace data exports (D2, C74): durable export records for the
-- asynchronous workspace archive (JSON: workflows, run metadata, knowledge
-- metadata, members).
--
-- A workspace admin requests an export; a runner builds the archive from the
-- engine's workspace-scoped reads and stores it here. The archive holds
-- metadata only -- never credential contents -- and an upstream failure is
-- recorded as failed with a reason, never as an empty archive presented as
-- complete. Downloads are scoped by row security to the tenant and by the
-- workspace check in the service; ready archives expire.
--
-- Erasure: this table is tenant-scoped and reached by the platform deletion
-- provider like every other tenant table (PLATFORM_TABLES, PLATFORM_DELETE_ORDER).
--
-- Rollback: DROP TABLE IF EXISTS "workspace_exports";
CREATE TABLE IF NOT EXISTS "workspace_exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('requested', 'running', 'ready', 'failed', 'expired')),
  "archive" jsonb,
  "failure_reason" text,
  "requested_by" text NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  CONSTRAINT "workspace_exports_archive_ready_check" CHECK (
    ("status" <> 'ready') OR ("archive" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "workspace_exports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_exports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS workspace_exports_tenant_isolation ON "workspace_exports";
--> statement-breakpoint
CREATE POLICY workspace_exports_tenant_isolation ON "workspace_exports"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_exports_workspace_status_idx"
ON "workspace_exports" ("tenant_id", "workspace_id", "status");
