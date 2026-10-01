-- D14: SES delivery events identify a completed email side-effect by the
-- provider message id. A later bounce is a durable delivery failure.
ALTER TABLE "side_effects" ADD COLUMN "provider_message_id" text;
ALTER TABLE "side_effects" ADD COLUMN "delivery_failure_reason" text;
ALTER TABLE "side_effects" DROP CONSTRAINT "side_effects_status_check";
ALTER TABLE "side_effects" ADD CONSTRAINT "side_effects_status_check"
  CHECK ("status" IN ('attempted', 'completed', 'delivery_failed'));
CREATE UNIQUE INDEX "side_effects_provider_message_id_unique"
  ON "side_effects" ("tenant_id", "provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;
