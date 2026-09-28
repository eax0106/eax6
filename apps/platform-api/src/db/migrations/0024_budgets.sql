-- Budgets (task B2.9b; architecture C18 / F31): a workspace's spending limit for
-- a period, with thresholds that notify, warn or block. Spend itself is read
-- from the cost ledger when the budget is shown; nothing is copied here.
-- Enforcement of "block" belongs to the Run Manager's budget gate (C10).
--
-- Rollback: DROP TABLE budgets;
CREATE TABLE IF NOT EXISTS "budgets" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "workspace_id" uuid NOT NULL,
  "id" text NOT NULL,
  "name" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "period" text NOT NULL,
  "thresholds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "budgets_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "budgets_tenant_workspace_fk"
    FOREIGN KEY ("tenant_id", "workspace_id")
    REFERENCES "workspaces"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "budgets_id_format"
    CHECK ("id" ~ '^bud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "budgets_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "budgets_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "budgets_currency" CHECK ("currency" IN ('INR', 'USD')),
  CONSTRAINT "budgets_period" CHECK ("period" IN ('monthly')),
  CONSTRAINT "budgets_thresholds_array" CHECK (jsonb_typeof("thresholds") = 'array')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budgets_workspace_idx" ON "budgets" ("tenant_id", "workspace_id");
--> statement-breakpoint
DROP TRIGGER IF EXISTS budgets_prevent_tenant_id_update ON "budgets";
--> statement-breakpoint
CREATE TRIGGER budgets_prevent_tenant_id_update
BEFORE UPDATE OF "tenant_id" ON "budgets"
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_id_update();
--> statement-breakpoint
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "budgets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS budgets_tenant_isolation ON "budgets";
--> statement-breakpoint
CREATE POLICY budgets_tenant_isolation ON "budgets"
USING (
  "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
)
WITH CHECK (
  "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
);
