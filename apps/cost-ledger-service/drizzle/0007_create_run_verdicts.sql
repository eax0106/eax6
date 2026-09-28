-- Design log §21 / §22 item 10: verified-run billing charges only runs that
-- pass verification, so the ledger records each run's verdict beside its
-- cost from day one. One row per run; a replay of the same verdict is a
-- no-op, and a run's verdict is never rewritten.
CREATE TABLE "run_verdicts" (
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "verdict" text NOT NULL,
  "decided_at" timestamptz NOT NULL,
  "recorded_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "run_verdicts_pkey" PRIMARY KEY ("tenant_id", "run_id"),
  CONSTRAINT "run_verdicts_verdict_check" CHECK ("verdict" IN ('completed_verified', 'rescued', 'escalated', 'failed', 'abandoned', 'degraded'))
);
--> statement-breakpoint
CREATE TRIGGER "run_verdicts_reject_tenant_id_change"
BEFORE UPDATE ON "run_verdicts"
FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "run_verdicts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run_verdicts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "run_verdicts_tenant_context_isolation" ON "run_verdicts"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
