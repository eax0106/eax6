-- Budgets (D3, design log section 9 and 22, C10). The engine owns the budget
-- records so Run Manager can check them atomically at run start: a run
-- reserves its worst-case cost against every budget that applies to it in the
-- same transaction that creates the run, and a conditional UPDATE on the usage
-- row makes two runs starting at once unable to both pass the cap.
--
-- kind:  run_cap    the most one run of a workflow may cost (no period)
--        workflow   what one workflow may cost per day or month
--        workspace  what a workspace may cost per month (the umbrella)
-- mode:  hard       a run that would go over does not start (default)
--        warn       the run starts and an alert is raised; a person chose this
-- Amounts are INR minor units (paise), whole numbers only.
CREATE TABLE "budgets" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "workflow_id" text,
  "kind" text NOT NULL,
  "period" text,
  "amount_minor" bigint NOT NULL,
  "mode" text DEFAULT 'hard' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "budgets_id_format" CHECK ("id" ~ '^bud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "budgets_kind_check" CHECK ("kind" IN ('run_cap', 'workflow', 'workspace')),
  CONSTRAINT "budgets_period_check" CHECK ("period" IS NULL OR "period" IN ('daily', 'monthly')),
  CONSTRAINT "budgets_mode_check" CHECK ("mode" IN ('hard', 'warn')),
  CONSTRAINT "budgets_amount_positive" CHECK ("amount_minor" > 0),
  CONSTRAINT "budgets_shape_check" CHECK (
    ("kind" = 'run_cap' AND "period" IS NULL AND "workflow_id" IS NOT NULL) OR
    ("kind" = 'workflow' AND "period" IS NOT NULL AND "workflow_id" IS NOT NULL) OR
    ("kind" = 'workspace' AND "period" = 'monthly' AND "workflow_id" IS NULL)
  ),
  CONSTRAINT "budgets_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "budgets_workflow_tenant_fk" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflows"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_one_per_scope" ON "budgets"
  ("tenant_id", "workspace_id", "kind", COALESCE("workflow_id", ''), COALESCE("period", ''));
--> statement-breakpoint
CREATE TRIGGER "budgets_reject_tenant_id_change" BEFORE UPDATE ON "budgets" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "budgets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "budgets_tenant_context_isolation" ON "budgets"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
-- What a period budget has spent and what runs in flight have reserved.
CREATE TABLE "budget_usage" (
  "tenant_id" uuid NOT NULL,
  "budget_id" text NOT NULL,
  "period_key" text NOT NULL,
  "spent_minor" bigint DEFAULT 0 NOT NULL,
  "reserved_minor" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "budget_usage_pkey" PRIMARY KEY ("tenant_id", "budget_id", "period_key"),
  CONSTRAINT "budget_usage_nonnegative" CHECK ("spent_minor" >= 0 AND "reserved_minor" >= 0),
  CONSTRAINT "budget_usage_budget_fk" FOREIGN KEY ("tenant_id", "budget_id") REFERENCES "budgets"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "budget_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "budget_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "budget_usage_tenant_context_isolation" ON "budget_usage"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
--> statement-breakpoint
-- One row per run per budget it reserved against, so the end of the run can
-- release the reservation and true it up to what the run really cost, once.
CREATE TABLE "budget_reservations" (
  "tenant_id" uuid NOT NULL,
  "run_id" text NOT NULL,
  "budget_id" text NOT NULL,
  "period_key" text NOT NULL,
  "reserved_minor" bigint NOT NULL,
  "state" text DEFAULT 'reserved' NOT NULL,
  "settled_minor" bigint,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("tenant_id", "run_id", "budget_id"),
  CONSTRAINT "budget_reservations_state_check" CHECK ("state" IN ('reserved', 'settled')),
  CONSTRAINT "budget_reservations_run_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "budget_reservations_budget_fk" FOREIGN KEY ("tenant_id", "budget_id") REFERENCES "budgets"("tenant_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "budget_reservations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "budget_reservations_tenant_context_isolation" ON "budget_reservations"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
