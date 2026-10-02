import { bigint, check, foreignKey, index, jsonb, pgTable, sql, text, timestamp, uuid } from "@alterx/adapters";
import { conversations } from "./conversations";

export const conversationMessages = pgTable("conversation_messages", {
  id: text("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  ordinal: bigint("ordinal", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
  role: text("role").notNull(),
  kind: text("kind").notNull(),
  contentJson: jsonb("content_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "conversation_messages_conversation_workspace_fk", columns: [table.tenantId, table.workspaceId, table.conversationId], foreignColumns: [conversations.tenantId, conversations.workspaceId, conversations.id] }).onDelete("cascade"),
  index("conversation_messages_order_idx").on(table.tenantId, table.conversationId, table.ordinal),
  check("conversation_messages_role_check", sql`${table.role} IN ('user', 'assistant', 'system')`),
  check("conversation_messages_kind_check", sql`${table.kind} IN ('text', 'clarification', 'workflow', 'project', 'run', 'artifact', 'action')`),
  check("conversation_messages_content_check", sql`jsonb_typeof(${table.contentJson}) IN ('string', 'object')`),
]);
