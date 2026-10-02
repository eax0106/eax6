CREATE TABLE "connection_registry" (
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "connector_type" text NOT NULL,
  "status" text NOT NULL,
  "secret_ref" text NOT NULL,
  "source_revision" integer NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "connection_registry_pkey" PRIMARY KEY ("tenant_id", "connection_id"),
  CONSTRAINT "connection_registry_connector_check" CHECK ("connector_type" ~ '^[a-z][a-z0-9._-]{0,63}$'),
  CONSTRAINT "connection_registry_status_check" CHECK ("status" IN ('connected', 'revoked', 'error')),
  CONSTRAINT "connection_registry_revision_check" CHECK ("source_revision" > 0),
  CONSTRAINT "connection_registry_reference_check" CHECK (
    "secret_ref" = '/alter/integrations/' || "tenant_id"::text || '/' || "workspace_id"::text || '/' || "connection_id"::text
  )
);
--> statement-breakpoint
CREATE INDEX "connection_registry_workspace_connector_idx" ON "connection_registry" ("tenant_id", "workspace_id", "connector_type", "status");
--> statement-breakpoint
CREATE TRIGGER "connection_registry_reject_tenant_id_change" BEFORE UPDATE ON "connection_registry" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "connection_registry" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection_registry" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connection_registry_tenant_context_isolation" ON "connection_registry"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
