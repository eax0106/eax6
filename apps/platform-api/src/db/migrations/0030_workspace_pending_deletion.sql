-- Workspace pending deletion (D2, C79).
--
-- Deleting a workspace first puts it in 'pending_deletion' for an undo window
-- (WORKSPACE_DELETION_WINDOW_DAYS, default 7). While pending, the workspace is
-- hidden from lists, its members' workspace roles are not granted, and the
-- engine holds it (workspace_holds) so no run starts. Its data is untouched
-- until the window ends; the owner or an admin can restore it before then.
--
-- The three columns are set together exactly when the status is pending, so a
-- pending workspace always carries who asked and when the window ends.
--
-- Rollback: ALTER TABLE workspaces DROP CONSTRAINT workspaces_pending_deletion_shape,
--   DROP COLUMN deletion_requested_at, DROP COLUMN deletion_due_at,
--   DROP COLUMN deletion_requested_by; DROP INDEX IF EXISTS workspaces_deletion_due_idx;
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "deletion_requested_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "deletion_due_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "deletion_requested_by" text,
  DROP CONSTRAINT IF EXISTS "workspaces_pending_deletion_shape",
  ADD CONSTRAINT "workspaces_pending_deletion_shape" CHECK (
    ("status" = 'pending_deletion') = (
      "deletion_requested_at" IS NOT NULL
      AND "deletion_due_at" IS NOT NULL
      AND "deletion_requested_by" IS NOT NULL
    )
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_deletion_due_idx"
  ON "workspaces" ("deletion_due_at")
  WHERE "status" = 'pending_deletion';
