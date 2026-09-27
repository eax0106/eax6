import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { RepositoryBindingRecord, RepositoryProviderId } from "./types";

interface BindingRow {
  tenant_id: string;
  workspace_id: string;
  id: string;
  provider: RepositoryProviderId;
  connection_id: string;
  external_id: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export type NewRepositoryBinding = Omit<RepositoryBindingRecord, "createdAt" | "updatedAt">;

@Injectable()
export class RepositoryBindingRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  /** Inserts, or returns undefined when the workspace already binds this repository. */
  insert(binding: NewRepositoryBinding): Promise<RepositoryBindingRecord | undefined> {
    return this.withTenant(binding.tenantId, async (client) => {
      const result = await client.query<BindingRow>(
        `INSERT INTO repository_bindings
           (tenant_id, workspace_id, id, provider, connection_id, external_id,
            full_name, default_branch, private, html_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, workspace_id, provider, external_id) DO NOTHING
         RETURNING *`,
        [
          binding.tenantId,
          binding.workspaceId,
          binding.id,
          binding.provider,
          binding.connectionId,
          binding.externalId,
          binding.fullName,
          binding.defaultBranch,
          binding.private,
          binding.htmlUrl,
          binding.createdBy,
        ],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    });
  }

  list(tenantId: string, workspaceId: string): Promise<RepositoryBindingRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<BindingRow>(
        `SELECT * FROM repository_bindings
         WHERE tenant_id = $1 AND workspace_id = $2
         ORDER BY full_name, id`,
        [tenantId, workspaceId],
      );
      return result.rows.map(mapRow);
    });
  }

  find(tenantId: string, workspaceId: string, id: string): Promise<RepositoryBindingRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<BindingRow>(
        `SELECT * FROM repository_bindings
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [tenantId, workspaceId, id],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    });
  }

  delete(tenantId: string, workspaceId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM repository_bindings
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
        [tenantId, workspaceId, id],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }

  private async withTenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
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

function mapRow(row: BindingRow): RepositoryBindingRecord {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    id: row.id,
    provider: row.provider,
    connectionId: row.connection_id,
    externalId: row.external_id,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    private: row.private,
    htmlUrl: row.html_url,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
