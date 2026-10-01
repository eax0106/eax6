-- D14: SES delivery events identify a completed email side-effect by the
-- provider message id. A later bounce is a durable delivery failure.
ALTER TABLE "side_effects" ADD COLUMN "provider_message_id" text;
--> statement-breakpoint
ALTER TABLE "side_effects" ADD COLUMN "delivery_failure_reason" text;
--> statement-breakpoint
ALTER TABLE "side_effects" ADD COLUMN "delivery_confirmed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "side_effects" ADD COLUMN "delivery_failed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "side_effects" DROP CONSTRAINT "side_effects_status_check";
--> statement-breakpoint
ALTER TABLE "side_effects" ADD CONSTRAINT "side_effects_status_check"
  CHECK ("status" IN ('attempted', 'completed', 'delivery_failed'));
--> statement-breakpoint
CREATE UNIQUE INDEX "side_effects_provider_message_id_unique"
  ON "side_effects" ("tenant_id", "provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "side_effects_pending_delivery_failure"
  ON "side_effects" ("tenant_id", "id")
  WHERE "delivery_failed_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "verification_results" DROP CONSTRAINT "verification_results_gate_type_check";
--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_gate_type_check"
  CHECK ("gate_type" IN ('quality', 'hallucination', 'safety', 'build', 'render', 'placeholder', 'security', 'acceptance', 'mechanical'));
