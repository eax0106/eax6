import { ConnectionRegistrySnapshotSchema, type ConnectionRegistrySnapshot } from "@alterx/contracts";
import type { OrchestrationTenantStore } from "../compiler/graph-compiler.service";

export class ConnectionRegistryConflictError extends Error {}

export class ConnectionRegistryService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async upsert(input: ConnectionRegistrySnapshot): Promise<{ source_revision: number }> {
    const record = ConnectionRegistrySnapshotSchema.parse(input);
    return this.store.withTenant(record.tenant_id, async tx => {
      const result = await tx.query<{ source_revision: number }>(
        `INSERT INTO connection_registry (tenant_id, workspace_id, connection_id, connector_type, status, secret_ref, source_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, connection_id) DO UPDATE SET
           status=EXCLUDED.status, secret_ref=EXCLUDED.secret_ref, source_revision=EXCLUDED.source_revision, updated_at=clock_timestamp()
         WHERE connection_registry.workspace_id=EXCLUDED.workspace_id
           AND connection_registry.connector_type=EXCLUDED.connector_type
           AND connection_registry.source_revision < EXCLUDED.source_revision
         RETURNING source_revision`,
        [record.tenant_id, record.workspace_id, record.connection_id, record.connector_type, record.status, record.secret_ref, record.source_revision],
      );
      if (result.rows[0]) return result.rows[0];
      const current = (await tx.query<ConnectionRegistrySnapshot>(
        "SELECT tenant_id, workspace_id, connection_id, connector_type, status, secret_ref, source_revision FROM connection_registry WHERE tenant_id=$1 AND connection_id=$2",
        [record.tenant_id, record.connection_id],
      )).rows[0];
      if (!current || current.workspace_id !== record.workspace_id || current.connector_type !== record.connector_type ||
          (current.source_revision === record.source_revision && (current.status !== record.status || current.secret_ref !== record.secret_ref))) {
        throw new ConnectionRegistryConflictError("Connection scope or revision conflicts with the stored snapshot");
      }
      return { source_revision: current.source_revision };
    });
  }

  async list(tenantId: string, workspaceId: string): Promise<readonly ConnectionRegistrySnapshot[]> {
    return this.store.withTenant(tenantId, async tx => (await tx.query<ConnectionRegistrySnapshot>(
      "SELECT tenant_id, workspace_id, connection_id, connector_type, status, secret_ref, source_revision FROM connection_registry WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY connector_type, connection_id",
      [tenantId, workspaceId],
    )).rows);
  }
}
