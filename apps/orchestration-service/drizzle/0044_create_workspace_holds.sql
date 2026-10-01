-- D2 workspace pending deletion: while a workspace waits out its undo window
-- the platform places a hold here, and no trigger, schedule or webhook of
-- that workspace starts a run. The row is the whole state; removing it (on
-- restore) lets triggers fire again.
CREATE TABLE "workspace_holds" (
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "held_by" text NOT NULL,
  "held_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_holds_pkey" PRIMARY KEY ("tenant_id", "workspace_id")
);
--> statement-breakpoint
CREATE TRIGGER "workspace_holds_reject_tenant_id_change" BEFORE UPDATE ON "workspace_holds" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "workspace_holds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_holds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_holds_tenant_context_isolation" ON "workspace_holds"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
