ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_workspace_id_unique" UNIQUE ("tenant_id", "workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "workflow_id" text, ADD COLUMN "owner_user_id" uuid, ADD COLUMN "chat_type" text;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_workspace_id_unique" UNIQUE ("tenant_id", "workspace_id", "id"),
ADD CONSTRAINT "conversations_workflow_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id", "workflow_id") REFERENCES "workflows"("tenant_id", "workspace_id", "id"),
ADD CONSTRAINT "conversations_chat_type_check" CHECK (
  "chat_type" IS NULL OR
  ("chat_type" = 'workflow_builder' AND "workflow_id" IS NOT NULL) OR
  ("chat_type" = 'general' AND "workflow_id" IS NULL AND "owner_user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_workflow_chat" ON "conversations" ("tenant_id", "workflow_id") WHERE "chat_type" = 'workflow_builder';
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_user_assistant" ON "conversations" ("tenant_id", "workspace_id", "owner_user_id") WHERE "chat_type" = 'general';
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "conversation_id" text NOT NULL,
  "ordinal" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "role" text NOT NULL,
  "kind" text NOT NULL,
  "content_json" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_messages_conversation_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id", "conversation_id") REFERENCES "conversations"("tenant_id", "workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "conversation_messages_role_check" CHECK ("role" IN ('user', 'assistant', 'system')),
  CONSTRAINT "conversation_messages_kind_check" CHECK ("kind" IN ('text', 'clarification', 'workflow', 'project', 'run', 'artifact', 'action')),
  CONSTRAINT "conversation_messages_content_check" CHECK (jsonb_typeof("content_json") IN ('string', 'object'))
);
--> statement-breakpoint
CREATE INDEX "conversation_messages_order_idx" ON "conversation_messages" ("tenant_id", "conversation_id", "ordinal");
--> statement-breakpoint
CREATE TRIGGER "conversation_messages_reject_tenant_id_change" BEFORE UPDATE ON "conversation_messages" FOR EACH ROW EXECUTE FUNCTION reject_tenant_id_change();
--> statement-breakpoint
ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversation_messages_tenant_context_isolation" ON "conversation_messages"
USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
