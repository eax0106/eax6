import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  sql,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "@alterx/adapters";
import { conversations } from "./conversations";
import { events } from "./events";
import { projects } from "./projects";
import { triggers } from "./triggers";
import { workflowVersions } from "./workflow_versions";
import { workflows } from "./workflows";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    parentKind: text("parent_kind").notNull(),
    workflowId: text("workflow_id"),
    projectId: text("project_id"),
    workflowVersionId: text("workflow_version_id"),
    conversationId: text("conversation_id"),
    triggerId: text("trigger_id"),
    triggeringEventId: text("triggering_event_id"),
    replayedFrom: text("replayed_from"),
    replayConfirmedBy: uuid("replay_confirmed_by"),
    replayConfirmedAt: timestamp("replay_confirmed_at", { withTimezone: true }),
    replayActions: jsonb("replay_actions"),
    replayRequestKey: text("replay_request_key"),
    replayConfirmationToken: text("replay_confirmation_token"),
    provisioningSessionId: text("provisioning_session_id"),
    provisioningCycleId: text("provisioning_cycle_id"),
    provisioningTemplateId: text("provisioning_template_id"),
    provisioningClosedAt: timestamp("provisioning_closed_at", {
      withTimezone: true,
    }),
    status: text("status").notNull().default("pending"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp() + interval '24 hours'`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("runs_parent_kind_check", sql`${table.parentKind} IN ('workflow', 'project')`),
    check(
      "runs_status_check",
      sql`${table.status} IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')`,
    ),
    unique("runs_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("runs_replay_request_unique").on(table.tenantId, table.replayRequestKey),
    check("runs_replay_confirmation_check", sql`
      (${table.replayedFrom} IS NULL AND ${table.replayConfirmedBy} IS NULL AND ${table.replayConfirmedAt} IS NULL
        AND ${table.replayActions} IS NULL AND ${table.replayRequestKey} IS NULL AND ${table.replayConfirmationToken} IS NULL)
      OR (${table.replayedFrom} IS NOT NULL AND ${table.replayedFrom} = ${table.triggeringEventId}
        AND ${table.replayConfirmedBy} IS NOT NULL AND ${table.replayConfirmedAt} IS NOT NULL
        AND ${table.replayActions} IS NOT NULL AND jsonb_typeof(${table.replayActions}) = 'array'
        AND ${table.replayRequestKey} IS NOT NULL AND ${table.replayConfirmationToken} IS NOT NULL)`),
    foreignKey({ name: "runs_replay_event_tenant_fk", columns: [table.tenantId, table.replayedFrom],
      foreignColumns: [events.tenantId, events.eventId] }),
    foreignKey({
      name: "runs_workflow_tenant_fk",
      columns: [table.tenantId, table.workflowId],
      foreignColumns: [workflows.tenantId, workflows.id],
    }),
    foreignKey({
      name: "runs_project_tenant_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }),
    foreignKey({
      name: "runs_workflow_version_tenant_fk",
      columns: [table.tenantId, table.workflowVersionId],
      foreignColumns: [workflowVersions.tenantId, workflowVersions.id],
    }),
    foreignKey({
      name: "runs_conversation_tenant_fk",
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    foreignKey({
      name: "runs_trigger_tenant_fk",
      columns: [table.tenantId, table.triggerId],
      foreignColumns: [triggers.tenantId, triggers.id],
    }),
    foreignKey({
      name: "runs_triggering_event_tenant_fk",
      columns: [table.tenantId, table.triggeringEventId],
      foreignColumns: [events.tenantId, events.eventId],
    }),
    index("idx_runs_workflow").on(table.workflowId),
    index("idx_runs_tenant_project").on(table.tenantId, table.projectId),
    index("idx_runs_conversation").on(table.conversationId),
    index("idx_runs_tenant_status").on(table.tenantId, table.status),
    index("idx_runs_tenant_deadline").on(table.tenantId, table.deadlineAt),
    index("idx_runs_triggering_event").on(
      table.tenantId,
      table.triggeringEventId,
    ),
  ],
);
