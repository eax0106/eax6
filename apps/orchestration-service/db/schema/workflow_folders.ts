import { check, integer, pgTable, sql, text, unique, uuid } from "@alterx/adapters";

export const workflowFolders = pgTable("workflow_folders", {
  id: text("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  revision: integer("revision").notNull().default(0),
}, table => [
  check("workflow_folders_name_check", sql`length(btrim(${table.name})) BETWEEN 1 AND 160`),
  check("workflow_folders_revision_check", sql`${table.revision} >= 0`),
  unique("workflow_folders_tenant_workspace_id_unique").on(table.tenantId, table.workspaceId, table.id),
]);
