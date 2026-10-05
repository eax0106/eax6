import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type {
  AdminTenantActionView, AdminTenantView } from "./types";

interface TenantRow {
  id: string;
  name: string;
  status: string;
  region: string;
  identity_org_ref: string | null;
  created_at: Date;
}

export type TenantAdminAction =
  | "provisioned"
  | "suspended"
  | "reinstated"
  | "entitlement_overridden";

@Injectable()
export class AdminTenantsRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  async createTenant(
    id: string,
    name: string,
    identityOrgRef: string,
    region: string,
  ): Promise<AdminTenantView> {
    return this.withTenant(id, async (client) => {
      const result = await client.query<TenantRow>(
        `INSERT INTO tenants (id, name, status, region, identity_org_ref)
         VALUES ($1, $2, 'active', $3, $4)
         RETURNING id, name, status, region, identity_org_ref, created_at`,
        [id, name, region, identityOrgRef],
      );
      return mapRow(result.rows[0]!);
    });
  }

  /**
   * Cross-tenant by design (staff admin plane) — relays through the
   * `admin_list_tenants()` SECURITY DEFINER function (row_security off,
   * owned by platform_provisioner), same RLS-bypass pattern already used
   * by `resolve_existing_signup()`. Never query "tenants" directly for a
   * cross-tenant read; FORCE RLS on that table default-denies otherwise.
   */
  async list(): Promise<AdminTenantView[]> {
    const result = await this.pool.query<TenantRow>(
      `SELECT * FROM admin_list_tenants()`,
    );
    return result.rows.map(mapRow);
  }

  async find(id: string): Promise<AdminTenantView | undefined> {
    return this.withTenant(id, async (client) => {
      const result = await client.query<TenantRow>(
        `SELECT id, name, status, region, identity_org_ref, created_at
         FROM tenants WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    });
  }

  async setStatus(
    id: string,
    status: "active" | "suspended",
  ): Promise<AdminTenantView | undefined> {
    return this.withTenant(id, async (client) => {
      const result = await client.query<TenantRow>(
        `UPDATE tenants SET status = $2, updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING id, name, status, region, identity_org_ref, created_at`,
        [id, status],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    });
  }

  async recordAction(
    tenantId: string,
    staffUserId: string,
    action: TenantAdminAction,
    reason: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_admin_actions (id, tenant_id, staff_user_id, action, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [`taa_${randomUUID()}`, tenantId, staffUserId, action, reason],
    );
  }

  /**
   * The tenant's staff action history (tenant_admin_actions is append-only
   * and has no RLS; it is only reachable through staff routes). Newest first,
   * capped: this is a timeline, not an export.
   */
  async listActions(tenantId: string): Promise<AdminTenantActionView[]> {
    const result = await this.pool.query<{
      id: string;
      action: string;
      reason: string | null;
      staff_email: string;
      occurred_at: Date;
    }>(
      `SELECT a.id, a.action, a.reason, s.email AS staff_email, a.occurred_at
       FROM tenant_admin_actions a
       JOIN staff_users s ON s.id = a.staff_user_id
       WHERE a.tenant_id = $1
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT 100`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      reason: row.reason,
      staff_email: row.staff_email,
      occurred_at: row.occurred_at.toISOString(),
    }));
  }

  async appendNote(
    subjectId: string,
    staffUserId: string,
    body: string,
    acknowledgeAudit: (noteId: string) => Promise<unknown>,
  ): Promise<AdminTenantActionView | undefined> {
    return this.withTenant(subjectId, async (client) => {
      const subject = await client.query(
        "SELECT id FROM tenants WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [subjectId],
      );
      if (!subject.rows.length) return undefined;
      const result = await client.query<{
        id: string; action: string; reason: string; staff_email: string; occurred_at: Date;
      }>(
        `INSERT INTO tenant_admin_actions (id,tenant_id,staff_user_id,action,reason)
         VALUES ($1,$2,$3,'note_added',$4)
         RETURNING id,action,reason,occurred_at,
           (SELECT email FROM staff_users WHERE id=$3) AS staff_email`,
        [`taa_${randomUUID()}`,subjectId,staffUserId,body],
      );
      const note = result.rows[0]!;
      await acknowledgeAudit(note.id);
      return { ...note, occurred_at: note.occurred_at.toISOString() };
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

function mapRow(row: TenantRow): AdminTenantView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    region: row.region,
    identity_org_ref: row.identity_org_ref,
    created_at: row.created_at.toISOString(),
  };
}
