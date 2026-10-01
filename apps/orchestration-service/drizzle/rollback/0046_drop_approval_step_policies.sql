ALTER TABLE "runs" DROP COLUMN IF EXISTS "flags";
UPDATE "approvals" SET "status" = 'expired' WHERE "status" = 'skipped';
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_status_check";
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired'));
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_mode_check";
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "policy_set_by";
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "mode";
DROP TABLE IF EXISTS "approval_step_policies";
