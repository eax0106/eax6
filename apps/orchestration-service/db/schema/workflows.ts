import {
  check,
  pgTable,
  sql,
  text,
  timestamp,
  unique,
  uuid,
} from "@alterx/adapters";

export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "workflows_status_check",
      sql`${table.status} IN ('draft', 'active', 'archived')`,
    ),
    unique("workflows_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("workflows_tenant_workspace_id_unique").on(table.tenantId, table.workspaceId, table.id),
  ],
);
