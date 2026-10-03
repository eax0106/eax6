import {
  check,
  index,
  foreignKey,
  uniqueIndex,
  integer,
  pgTable,
  sql,
  text,
  timestamp,
  unique,
  uuid,
} from "@alterx/adapters";
import { workflows } from "./workflows";

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    channel: text("channel").notNull(),
    workflowId: text("workflow_id"),
    ownerUserId: uuid("owner_user_id"),
    chatType: text("chat_type"),
    temporalWorkflowId: text("temporal_workflow_id").notNull().unique(),
    status: text("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull().default(1800),
  },
  (table) => [
    check(
      "conversations_channel_check",
      sql`${table.channel} IN ('web', 'whatsapp', 'api')`,
    ),
    check(
      "conversations_status_check",
      sql`${table.status} IN ('active', 'idle', 'closed', 'archived')`,
    ),
    unique("conversations_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("conversations_tenant_workspace_id_unique").on(table.tenantId, table.workspaceId, table.id),
    foreignKey({ name: "conversations_workflow_workspace_fk", columns: [table.tenantId, table.workspaceId, table.workflowId], foreignColumns: [workflows.tenantId, workflows.workspaceId, workflows.id] }),
    check("conversations_chat_type_check", sql`${table.chatType} IS NULL OR (${table.chatType}='workflow_builder' AND ${table.workflowId} IS NOT NULL) OR (${table.chatType}='general' AND ${table.workflowId} IS NULL AND ${table.ownerUserId} IS NOT NULL)`),
    uniqueIndex("conversations_one_workflow_chat").on(table.tenantId, table.workflowId).where(sql`${table.chatType}='workflow_builder'`),
    uniqueIndex("conversations_one_user_assistant").on(table.tenantId, table.workspaceId, table.ownerUserId).where(sql`${table.chatType}='general'`),
    index("idx_conversations_tenant_status").on(
      table.tenantId,
      table.status,
    ),
  ],
);
