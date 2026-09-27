-- Repository Manager (C9, task 5.2): a workspace's links to source repositories
-- it reaches through one of its own OAuth connections. The binding stores what
-- identifies the repository and which connection reaches it -- never a token.
-- Branches and pull requests are read live from the provider, not copied here.
--
-- external_id is the provider's stable numeric repository id, so a rename or a
-- transfer on the provider side does not create a second binding.
--
-- Rollback: DROP TABLE repository_bindings;
CREATE TABLE IF NOT EXISTS "repository_bindings" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "workspace_id" uuid NOT NULL,
  "id" text NOT NULL,
  "provider" text NOT NULL,
  "connection_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "full_name" text NOT NULL,
  "default_branch" text NOT NULL,
  "private" boolean NOT NULL,
  "html_url" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "repository_bindings_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "repository_bindings_tenant_workspace_fk"
    FOREIGN KEY ("tenant_id", "workspace_id")
    REFERENCES "workspaces"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "repository_bindings_one_per_repository"
    UNIQUE ("tenant_id", "workspace_id", "provider", "external_id"),
  CONSTRAINT "repository_bindings_id_format"
    CHECK ("id" ~ '^rep_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "repository_bindings_provider" CHECK ("provider" IN ('github')),
  CONSTRAINT "repository_bindings_full_name_format"
    CHECK ("full_name" ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$')
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS repository_bindings_prevent_tenant_id_update ON "repository_bindings";
--> statement-breakpoint
CREATE TRIGGER repository_bindings_prevent_tenant_id_update
BEFORE UPDATE OF "tenant_id" ON "repository_bindings"
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_id_update();
--> statement-breakpoint
ALTER TABLE "repository_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "repository_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS repository_bindings_tenant_isolation ON "repository_bindings";
--> statement-breakpoint
CREATE POLICY repository_bindings_tenant_isolation ON "repository_bindings"
USING (
  "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
)
WITH CHECK (
  "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
);
