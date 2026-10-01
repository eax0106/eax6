-- These run-only questions have no representation in the previous schema.
DELETE FROM "clarifications" WHERE "conversation_id" IS NULL;
DROP INDEX "clarifications_recovery_unique";
ALTER TABLE "clarifications" DROP CONSTRAINT "clarifications_recovery_tenant_fk";
ALTER TABLE "clarifications" DROP CONSTRAINT "clarifications_source_check";
ALTER TABLE "clarifications" DROP COLUMN "answer";
ALTER TABLE "clarifications" DROP COLUMN "recovery_action_id";
ALTER TABLE "clarifications" ALTER COLUMN "conversation_id" SET NOT NULL;
