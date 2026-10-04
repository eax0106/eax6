import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { PlatformDb } from "../signup/platform-db";

export interface UserProfileRow {
  id: string;
  identity_ref: string;
  email: string;
  display_name: string | null;
}

@Injectable()
export class UserProfileRepository {
  constructor(private readonly pool: Pool | undefined) {}

  async workspaceAccess(tenantId: string, userId: string): Promise<{ tenantRole: string | null; workspaceRoles: Array<{ workspaceId: string; role: string }> }> {
    if (!this.pool) return { tenantRole: null, workspaceRoles: [] };
    return new PlatformDb(this.pool).withTenant(tenantId, async client => {
      const tenant = await client.query<{ role: string }>(
        "SELECT role FROM tenant_members WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
      const workspaces = await client.query<{ workspaceId: string; role: string }>(
        `SELECT w.id AS "workspaceId", wm.role FROM workspace_members wm
         JOIN workspaces w ON w.id=wm.workspace_id AND w.tenant_id=wm.tenant_id
         WHERE wm.tenant_id=$1 AND wm.user_id=$2 AND w.status='active' ORDER BY w.created_at,w.id`, [tenantId, userId]);
      return { tenantRole: tenant.rows[0]?.role ?? null, workspaceRoles: workspaces.rows };
    });
  }

  async findById(userId: string): Promise<UserProfileRow | null> {
    if (!this.pool) {
      return null;
    }
    const result = await this.pool.query<UserProfileRow>(
      "SELECT id, identity_ref, email, display_name FROM users WHERE id = $1",
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async updateDisplayName(userId: string, displayName: string): Promise<UserProfileRow | null> {
    if (!this.pool) {
      return null;
    }
    const result = await this.pool.query<UserProfileRow>(
      "UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, identity_ref, email, display_name",
      [userId, displayName],
    );
    return result.rows[0] ?? null;
  }
}
