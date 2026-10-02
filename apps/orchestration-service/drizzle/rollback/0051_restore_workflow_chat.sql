DROP TABLE IF EXISTS "conversation_messages";
DROP INDEX IF EXISTS "conversations_one_user_assistant";
DROP INDEX IF EXISTS "conversations_one_workflow_chat";
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_chat_type_check", DROP CONSTRAINT IF EXISTS "conversations_workflow_workspace_fk", DROP CONSTRAINT IF EXISTS "conversations_tenant_workspace_id_unique";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "chat_type", DROP COLUMN IF EXISTS "owner_user_id", DROP COLUMN IF EXISTS "workflow_id";
ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_tenant_workspace_id_unique";
