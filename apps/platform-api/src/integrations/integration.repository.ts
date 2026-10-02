import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { ConnectorId } from "./connectors";
import type { ConnectorTenantConfig } from "./connectors";
import type {
  IntegrationActivityQuery,
  OAuthConnectionActivityRecord,
  OAuthConnectionRecord,
  OAuthStateRecord,
  WorkspaceConnectorConfigRecord,
} from "./types";

interface WorkspaceConnectorConfigRow {
  tenant_id: string;
  workspace_id: string;
  connector: string;
  config_json: ConnectorTenantConfig;
  created_at: Date;
  updated_at: Date;
}

interface OAuthStateRow {
  tenant_id: string;
  id: string;
  workspace_id: string;
  connector: string;
  code_verifier: string | null;
  redirect_uri: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
}

interface OAuthConnectionRow {
  tenant_id: string;
  id: string;
  workspace_id: string;
  connector: string;
  source_revision: number;
  external_account_id: string;
  scopes: string;
  status: string;
  last_health_status: string | null;
  last_health_checked_at: Date | null;
  revoked_at: Date | null;
  use_audit_ptr: string | null;
  created_at: Date;
  updated_at: Date;
}

interface OAuthConnectionUseAuditRow {
  tenant_id: string;
  id: string;
  connection_id: string;
  action: string;
  used_at: Date;
}

export class ActivityCursorNotFoundError extends Error {
  constructor() {
    super("Activity cursor does not belong to this connection");
    this.name = "ActivityCursorNotFoundError";
  }
}

export interface CreateOAuthStateInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly connector: ConnectorId;
  readonly codeVerifier: string | null;
  readonly redirectUri: string;
  readonly createdBy: string;
  readonly expiresAt: Date;
}

export interface CreateOAuthConnectionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly connector: ConnectorId;
  readonly externalAccountId: string;
  readonly scopes: string;
}

@Injectable()
export class IntegrationRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  upsertConnectorConfig(
    tenantId: string,
    workspaceId: string,
    connector: ConnectorId,
    config: ConnectorTenantConfig,
  ): Promise<WorkspaceConnectorConfigRecord> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<WorkspaceConnectorConfigRow>(
        `INSERT INTO workspace_connector_configs
           (tenant_id, workspace_id, connector, config_json)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id, workspace_id, connector) DO UPDATE
         SET config_json = EXCLUDED.config_json,
             updated_at = clock_timestamp()
         RETURNING *`,
        [tenantId, workspaceId, connector, JSON.stringify(config)],
      );
      return mapConnectorConfigRow(result.rows[0]!);
    });
  }

  findConnectorConfig(
    tenantId: string,
    workspaceId: string,
    connector: ConnectorId,
  ): Promise<WorkspaceConnectorConfigRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<WorkspaceConnectorConfigRow>(
        `SELECT * FROM workspace_connector_configs
         WHERE tenant_id = $1 AND workspace_id = $2 AND connector = $3`,
        [tenantId, workspaceId, connector],
      );
      return result.rows[0] ? mapConnectorConfigRow(result.rows[0]) : undefined;
    });
  }

  createState(
    tenantId: string,
    input: CreateOAuthStateInput,
  ): Promise<OAuthStateRecord> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OAuthStateRow>(
        `INSERT INTO oauth_states
           (tenant_id, id, workspace_id, connector, code_verifier, redirect_uri, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          tenantId,
          input.id,
          input.workspaceId,
          input.connector,
          input.codeVerifier,
          input.redirectUri,
          input.createdBy,
          input.expiresAt,
        ],
      );
      return mapStateRow(result.rows[0]!);
    });
  }

  findState(
    tenantId: string,
    id: string,
  ): Promise<OAuthStateRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OAuthStateRow>(
        `SELECT * FROM oauth_states WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return result.rows[0] ? mapStateRow(result.rows[0]) : undefined;
    });
  }

  async deleteState(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `DELETE FROM oauth_states WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
    });
  }

  createConnection(
    tenantId: string,
    input: CreateOAuthConnectionInput,
    persistReference?: (connectionId: string) => Promise<void>,
  ): Promise<OAuthConnectionRecord> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OAuthConnectionRow>(
        `INSERT INTO oauth_connections
           (tenant_id, id, workspace_id, connector, external_account_id, scopes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, workspace_id, connector, external_account_id) DO UPDATE SET
           scopes=EXCLUDED.scopes, status='connected', last_health_status=NULL,
           last_health_checked_at=NULL, revoked_at=NULL, updated_at=clock_timestamp(),
           source_revision=oauth_connections.source_revision+1
         RETURNING *`,
        [
          tenantId,
          input.id,
          input.workspaceId,
          input.connector,
          input.externalAccountId,
          input.scopes,
        ],
      );
      const record = mapConnectionRow(result.rows[0]!);
      // The account's unique row serializes reconnects through secret persistence.
      await persistReference?.(record.id);
      return record;
    });
  }

  listConnections(
    tenantId: string,
    workspaceId: string,
  ): Promise<OAuthConnectionRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OAuthConnectionRow>(
        `SELECT * FROM oauth_connections
         WHERE tenant_id = $1 AND workspace_id = $2
         ORDER BY created_at DESC, id`,
        [tenantId, workspaceId],
      );
      return result.rows.map(mapConnectionRow);
    });
  }

  findConnection(
    tenantId: string,
    workspaceId: string,
    id: string,
  ): Promise<OAuthConnectionRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OAuthConnectionRow>(
        `SELECT * FROM oauth_connections
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [tenantId, workspaceId, id],
      );
      return result.rows[0] ? mapConnectionRow(result.rows[0]) : undefined;
    });
  }

  updateHealth(
    tenantId: string,
    workspaceId: string,
    id: string,
    status: string,
    checkedAt: Date,
  ): Promise<OAuthConnectionRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OAuthConnectionRow>(
        `UPDATE oauth_connections
         SET last_health_status = $4,
             last_health_checked_at = $5,
             source_revision = source_revision + 1,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         RETURNING *`,
        [tenantId, workspaceId, id, status, checkedAt],
      );
      return result.rows[0] ? mapConnectionRow(result.rows[0]) : undefined;
    });
  }

  revokeConnection(
    tenantId: string,
    workspaceId: string,
    id: string,
  ): Promise<OAuthConnectionRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OAuthConnectionRow>(
        `UPDATE oauth_connections
         SET status = 'revoked',
             revoked_at = clock_timestamp(),
             source_revision = source_revision + 1,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         RETURNING *`,
        [tenantId, workspaceId, id],
      );
      return result.rows[0] ? mapConnectionRow(result.rows[0]) : undefined;
    });
  }

  async recordUse(
    tenantId: string,
    connectionId: string,
    usedBy: string,
    action: string,
  ): Promise<string> {
    return this.withTenant(tenantId, async (client) => {
      const auditId = randomUUID();
      await client.query(
        `INSERT INTO oauth_connection_use_audits
           (tenant_id, id, connection_id, used_by, action)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, auditId, connectionId, usedBy, action],
      );
      await client.query(
        `UPDATE oauth_connections SET use_audit_ptr = $3
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, connectionId, auditId],
      );
      return auditId;
    });
  }

  listActivity(
    tenantId: string,
    connectionId: string,
    query: IntegrationActivityQuery,
  ): Promise<{
    readonly data: readonly OAuthConnectionActivityRecord[];
    readonly page: { readonly next_cursor: string | null; readonly has_more: boolean; readonly limit: number };
  }> {
    const limit = query.limit ?? 50;
    return this.withTenant(tenantId, async (client) => {
      const values: unknown[] = [tenantId, connectionId];
      const conditions = ["tenant_id = $1", "connection_id = $2"];
      if (query.cursor) {
        const cursor = await client.query<{ used_at: Date }>(
          `SELECT used_at
           FROM oauth_connection_use_audits
           WHERE tenant_id = $1 AND connection_id = $2 AND id = $3`,
          [tenantId, connectionId, query.cursor],
        );
        const usedAt = cursor.rows[0]?.used_at;
        if (!usedAt) throw new ActivityCursorNotFoundError();
        values.push(usedAt, query.cursor);
        conditions.push(
          `(used_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);
      const result = await client.query<OAuthConnectionUseAuditRow>(
        `SELECT tenant_id, id, connection_id, action, used_at
         FROM oauth_connection_use_audits
         WHERE ${conditions.join(" AND ")}
         ORDER BY used_at DESC, id DESC
         LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.map(mapActivityRow);
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return {
        data,
        page: {
          next_cursor: hasMore ? data.at(-1)?.id ?? null : null,
          has_more: hasMore,
          limit,
        },
      };
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }

  private async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapConnectorConfigRow(
  row: WorkspaceConnectorConfigRow,
): WorkspaceConnectorConfigRecord {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    connector: row.connector as ConnectorId,
    config: row.config_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStateRow(row: OAuthStateRow): OAuthStateRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    workspaceId: row.workspace_id,
    connector: row.connector as ConnectorId,
    codeVerifier: row.code_verifier,
    redirectUri: row.redirect_uri,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function mapConnectionRow(row: OAuthConnectionRow): OAuthConnectionRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    workspaceId: row.workspace_id,
    connector: row.connector as ConnectorId,
    sourceRevision: row.source_revision,
    externalAccountId: row.external_account_id,
    scopes: row.scopes,
    status: row.status as OAuthConnectionRecord["status"],
    lastHealthStatus: row.last_health_status,
    lastHealthCheckedAt: row.last_health_checked_at,
    revokedAt: row.revoked_at,
    useAuditPtr: row.use_audit_ptr,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActivityRow(
  row: OAuthConnectionUseAuditRow,
): OAuthConnectionActivityRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    connectionId: row.connection_id,
    action: row.action,
    usedAt: row.used_at,
  };
}
