import type { Pool } from "pg";
import type { DigestEligibleUser } from "./types";

/**
 * Real cross-tenant enumeration for the digest scheduler. Mirrors
 * ads-core's deletion provider's real system_sessions pattern exactly: a
 * SEPARATE Postgres connection pool, authenticated as a role with a real
 * BYPASSRLS grant, provisioned at deploy time -- never the normal
 * per-request tenant-scoped pool used by NotificationRepository. Narrow,
 * single-purpose (one query), not a general escape hatch.
 *
 * The bypass-RLS pool itself is real infra provisioning (a new Postgres
 * role on platform_db with BYPASSRLS) -- out of this service's own
 * deploy scope. Until that role exists, `pool` stays undefined and the
 * digest scheduler fails closed with a real, disclosed error rather than
 * silently skipping or fabricating results.
 */
export class SystemNotificationStore {
  constructor(private readonly pool: Pool | undefined) {}

  /**
   * Every tenant that is live, for the engine-event producers, which read the
   * engine once per tenant as the system principal (D1). Ids only.
   */
  async listActiveTenantIds(): Promise<string[]> {
    if (!this.pool) {
      throw new SystemNotificationStoreNotConfiguredError();
    }
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE status = 'active' ORDER BY id`,
    );
    return result.rows.map((row) => row.id);
  }

  async listUsersDueForDigest(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<DigestEligibleUser[]> {
    if (!this.pool) {
      throw new SystemNotificationStoreNotConfiguredError();
    }
    const result = await this.pool.query<{ tenant_id: string; user_id: string }>(
      `SELECT DISTINCT p.tenant_id, p.user_id
         FROM notification_preferences p
        WHERE p.channel = 'email' AND p.enabled = true AND p.delivery_mode = 'digest'
          AND EXISTS (
            SELECT 1 FROM notification_events e
             JOIN notification_reads r
               ON r.tenant_id = e.tenant_id AND r.notification_event_id = e.id
             WHERE e.tenant_id = p.tenant_id AND r.user_id = p.user_id
               AND e.event_class = p.event_class
               AND e.created_at >= $1 AND e.created_at < $2
          )`,
      [periodStart, periodEnd],
    );
    return result.rows.map((row) => ({ tenantId: row.tenant_id, userId: row.user_id }));
  }
}

export class SystemNotificationStoreNotConfiguredError extends Error {
  constructor() {
    super(
      "SystemNotificationStore has no bypass-RLS pool configured -- provision the platform_db system role before enabling digest scheduling",
    );
    this.name = "SystemNotificationStoreNotConfiguredError";
  }
}
