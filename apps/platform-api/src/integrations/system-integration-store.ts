import type { Pool } from "pg";

export interface ConnectionRef {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly id: string;
}

/**
 * Real cross-tenant enumeration for the connector health-sweep job.
 * Mirrors notifications' SystemNotificationStore exactly: a SEPARATE
 * Postgres connection pool, authenticated as a role with a real
 * BYPASSRLS grant, provisioned at deploy time -- never the normal
 * per-request tenant-scoped pool used by IntegrationRepository. Narrow,
 * single-purpose (one query), not a general escape hatch.
 *
 * Until the real platform_db system role exists, `pool` stays undefined
 * and the health sweep fails closed with a real, disclosed error rather
 * than silently skipping or fabricating results.
 */
export class SystemIntegrationStore {
  constructor(private readonly pool: Pool | undefined) {}

  async listConnections(): Promise<ConnectionRef[]> {
    if (!this.pool) {
      throw new SystemIntegrationStoreNotConfiguredError();
    }
    const result = await this.pool.query<{
      tenant_id: string;
      workspace_id: string;
      id: string;
    }>(`SELECT tenant_id, workspace_id, id FROM oauth_connections`);
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      id: row.id,
    }));
  }
}

export class SystemIntegrationStoreNotConfiguredError extends Error {
  constructor() {
    super(
      "SystemIntegrationStore has no bypass-RLS pool configured -- provision the platform_db system role before enabling the connector health sweep",
    );
    this.name = "SystemIntegrationStoreNotConfiguredError";
  }
}
