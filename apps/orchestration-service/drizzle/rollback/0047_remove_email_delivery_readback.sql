DROP INDEX IF EXISTS "side_effects_provider_message_id_unique";
ALTER TABLE "side_effects" DROP CONSTRAINT "side_effects_status_check";
ALTER TABLE "side_effects" ADD CONSTRAINT "side_effects_status_check"
  CHECK ("status" IN ('attempted', 'completed'));
ALTER TABLE "side_effects" DROP COLUMN "delivery_failure_reason";
ALTER TABLE "side_effects" DROP COLUMN "provider_message_id";
