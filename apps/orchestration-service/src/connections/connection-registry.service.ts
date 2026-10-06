import { ConnectionCredentialLookupSchema, parseConnectionSecretReference, ConnectionRegistrySnapshotSchema, RunScopeLookupSchema, RunScopeSchema, type ConnectionCredentialLookup, type ConnectionRegistrySnapshot, type RunScope, type RunScopeLookup } from "@alterx/contracts";
import type { OrchestrationTenantStore } from "../compiler/graph-compiler.service";

export class ConnectionRegistryConflictError extends Error {}
export class ConnectionRegistryUnavailableError extends Error {}

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

  async resolve(input: ConnectionCredentialLookup): Promise<ConnectionRegistrySnapshot> {
    const request = ConnectionCredentialLookupSchema.parse(input);
    const reference = parseConnectionSecretReference(request.credential_ref)!;
    const tenantId = request.tenant_id.slice("ten_".length);
    if (reference.tenant_id !== tenantId) throw new ConnectionRegistryUnavailableError("CREDENTIAL_MISSING");
    return this.store.withTenant(tenantId, async tx => {
      const row = (await tx.query<ConnectionRegistrySnapshot>(
        `SELECT c.tenant_id, c.workspace_id, c.connection_id, c.connector_type, c.status, c.secret_ref, c.source_revision
         FROM runs r JOIN connection_registry c ON c.tenant_id=r.tenant_id AND c.workspace_id=r.workspace_id
         WHERE r.tenant_id=$1 AND r.id=$2 AND c.connection_id=$3 AND c.workspace_id=$4 AND c.status='connected'`,
        [tenantId, request.run_id, reference.connection_id, reference.workspace_id],
      )).rows[0];
      if (!row || row.secret_ref !== request.credential_ref) throw new ConnectionRegistryUnavailableError("CREDENTIAL_MISSING");
      return ConnectionRegistrySnapshotSchema.parse(row);
    });
  }

  /** The run's workspace and its connected WhatsApp accounts, for Tool Gateway's knowledge and WhatsApp tools. */
  async runScope(input: RunScopeLookup): Promise<RunScope> {
    const request = RunScopeLookupSchema.parse(input);
    const tenantId = request.tenant_id.slice("ten_".length);
    return this.store.withTenant(tenantId, async tx => {
      const run = (await tx.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM runs WHERE tenant_id=$1 AND id=$2", [tenantId, request.run_id],
      )).rows[0];
      if (!run) throw new ConnectionRegistryUnavailableError("RUN_NOT_FOUND");
      const accounts = (await tx.query<{ account_id: string; phone_number_id: string; access_token_ref: string }>(
        `SELECT id AS account_id, phone_number_id, access_token_ref FROM whatsapp_accounts
         WHERE tenant_id=$1 AND workspace_id=$2 AND status='connected' ORDER BY created_at, id LIMIT 20`,
        [tenantId, run.workspace_id],
      )).rows;
      return RunScopeSchema.parse({ workspace_id: run.workspace_id, whatsapp_accounts: accounts });
    });
  }

  async list(tenantId: string, workspaceId: string): Promise<readonly ConnectionRegistrySnapshot[]> {
    return this.store.withTenant(tenantId, async tx => (await tx.query<ConnectionRegistrySnapshot>(
      "SELECT tenant_id, workspace_id, connection_id, connector_type, status, secret_ref, source_revision FROM connection_registry WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY connector_type, connection_id",
      [tenantId, workspaceId],
    )).rows);
  }
}
