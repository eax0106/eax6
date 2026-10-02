import { check, index, integer, pgTable, primaryKey, sql, text, timestamp, uuid } from "@alterx/adapters";

export const connectionRegistry = pgTable(
  "connection_registry",
  {
    tenantId: uuid("tenant_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    connectorType: text("connector_type").notNull(),
    status: text("status").notNull(),
    secretRef: text("secret_ref").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    primaryKey({ name: "connection_registry_pkey", columns: [table.tenantId, table.connectionId] }),
    index("connection_registry_workspace_connector_idx").on(table.tenantId, table.workspaceId, table.connectorType, table.status),
    check("connection_registry_connector_check", sql`${table.connectorType} ~ '^[a-z][a-z0-9._-]{0,63}$'`),
    check("connection_registry_status_check", sql`${table.status} IN ('connected', 'revoked', 'error')`),
    check("connection_registry_revision_check", sql`${table.sourceRevision} > 0`),
    check("connection_registry_reference_check", sql`${table.secretRef} = '/alter/integrations/' || ${table.tenantId}::text || '/' || ${table.workspaceId}::text || '/' || ${table.connectionId}::text`),
  ],
);
