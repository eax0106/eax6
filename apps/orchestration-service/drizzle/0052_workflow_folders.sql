CREATE TABLE "workflow_folders" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "workflow_folders_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 160),
  CONSTRAINT "workflow_folders_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "workflow_folders_tenant_workspace_id_unique" UNIQUE ("tenant_id", "workspace_id", "id")
);
--> statement-breakpoint
ALTER TABLE "workflow_folders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_folders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workflow_folders_tenant_context_isolation" ON "workflow_folders"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER "workflow_folders_reject_tenant_id_change" BEFORE UPDATE ON "workflow_folders" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "folder_id" text, ADD COLUMN "folder_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_folder_workspace_fk"
FOREIGN KEY ("tenant_id", "workspace_id", "folder_id") REFERENCES "workflow_folders" ("tenant_id", "workspace_id", "id");
--> statement-breakpoint
CREATE INDEX "workflows_folder_idx" ON "workflows" ("tenant_id", "workspace_id", "folder_id");
