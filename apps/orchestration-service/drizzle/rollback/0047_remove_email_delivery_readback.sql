DROP INDEX IF EXISTS "side_effects_provider_message_id_unique";
DROP INDEX IF EXISTS "side_effects_pending_delivery_failure";
ALTER TABLE "side_effects" DROP CONSTRAINT "side_effects_status_check";
-- Preserve evidence that the action happened. The run flag and journal remain.
UPDATE "side_effects" SET "status" = 'completed' WHERE "status" = 'delivery_failed';
ALTER TABLE "side_effects" ADD CONSTRAINT "side_effects_status_check"
  CHECK ("status" IN ('attempted', 'completed'));
ALTER TABLE "side_effects" DROP COLUMN "delivery_failure_reason";
ALTER TABLE "side_effects" DROP COLUMN "provider_message_id";
ALTER TABLE "side_effects" DROP COLUMN "delivery_confirmed_at";
ALTER TABLE "side_effects" DROP COLUMN "delivery_failed_at";
DELETE FROM "verification_results" WHERE "gate_type" = 'mechanical';
ALTER TABLE "verification_results" DROP CONSTRAINT "verification_results_gate_type_check";
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_gate_type_check"
  CHECK ("gate_type" IN ('quality', 'hallucination', 'safety', 'build', 'render', 'placeholder', 'security', 'acceptance'));
