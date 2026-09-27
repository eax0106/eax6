import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import type { AdminUserActionView, AdminUserView, UserAdminAction } from "./types";

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  status: "active" | "suspended";
  created_at: Date;
  tenant_ids: string[];
  last_seen_at: Date | null;
  active_sessions: number;
}

/**
 * Staff plane, cross-tenant by design. Reads go through admin_list_users()
 * and session revocation through admin_revoke_user_sessions() -- SECURITY
 * DEFINER functions (migration 0022), because tenant_members and
 * user_sessions are tenant-RLS tables. users itself has no RLS.
 */
@Injectable()
export class AdminUsersRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  async list(): Promise<AdminUserView[]> {
    const result = await this.pool.query<UserRow>("SELECT * FROM admin_list_users(NULL)");
    return result.rows.map(mapUser);
  }

  async find(id: string): Promise<AdminUserView | undefined> {
    const result = await this.pool.query<UserRow>("SELECT * FROM admin_list_users($1)", [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async setStatus(id: string, status: "active" | "suspended"): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE users SET status = $2, updated_at = clock_timestamp() WHERE id = $1",
      [id, status],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeSessions(id: string): Promise<number> {
    const result = await this.pool.query<{ revoked: number }>(
      "SELECT admin_revoke_user_sessions($1) AS revoked",
      [id],
    );
    return result.rows[0]?.revoked ?? 0;
  }

  async recordAction(
    userId: string,
    staffUserId: string,
    action: UserAdminAction,
    reason: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_admin_actions (id, user_id, staff_user_id, action, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [`uaa_${randomUUID()}`, userId, staffUserId, action, reason],
    );
  }

  async listActions(userId: string): Promise<AdminUserActionView[]> {
    const result = await this.pool.query<{
      id: string;
      action: string;
      reason: string | null;
      staff_email: string;
      occurred_at: Date;
    }>(
      `SELECT a.id, a.action, a.reason, s.email AS staff_email, a.occurred_at
         FROM user_admin_actions a
         JOIN staff_users s ON s.id = a.staff_user_id
        WHERE a.user_id = $1
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT 100`,
      [userId],
    );
    return result.rows.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString() }));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }
}

function mapUser(row: UserRow): AdminUserView {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    status: row.status,
    tenant_ids: row.tenant_ids ?? [],
    created_at: row.created_at.toISOString(),
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    active_sessions: row.active_sessions,
  };
}
