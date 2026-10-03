DROP INDEX "workflows_folder_idx";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_folder_workspace_fk", DROP COLUMN "folder_id", DROP COLUMN "folder_revision";
--> statement-breakpoint
DROP TABLE "workflow_folders";
