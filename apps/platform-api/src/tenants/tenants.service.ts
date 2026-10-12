import type { AuditEventHandler } from "@alterx/shared-clients";
import { z } from "zod";
import { computeEtag, ConcurrencyHttpError, ifMatchIncludes } from "../concurrency";
import { TenantDataResidencySchema } from "../planner-facade/tenant-residency.repository";
import type { ActorContext } from "../rbac/types";
import { PlatformHttpError } from "../signup/problem";
import { PlatformDb } from "../signup/platform-db";

export interface TenantView {
  id: string;
  name: string;
  status: string;
  region: string;
  role: string;
}

/** The tenant's data residency as stored; null when the tenant pins nothing. */
export interface TenantDataResidencyView {
  data_residency: unknown;
}

export const TenantDataResidencyBodySchema = z
  .object({ data_residency: TenantDataResidencySchema.nullable() })
  .strict();

export class TenantsService {
  constructor(
    private readonly db: PlatformDb,
    private readonly audit: AuditEventHandler,
  ) {}

  list(actor: ActorContext): Promise<TenantView[]> {
    return this.db.queryTenant<TenantView>(
      actor.tenant_id,
      `SELECT t.id, t.name, t.status, t.region, tm.role
         FROM tenants t
         JOIN tenant_members tm ON tm.tenant_id = t.id
        WHERE tm.user_id = $1 AND t.id = $2
        ORDER BY t.created_at`,
      [actor.user_id, actor.tenant_id],
    );
  }

  async get(actor: ActorContext, tenantId: string): Promise<TenantView> {
    const rows = await this.db.queryTenant<TenantView>(
      tenantId,
      `SELECT t.id, t.name, t.status, t.region, tm.role
         FROM tenants t
         JOIN tenant_members tm ON tm.tenant_id = t.id
        WHERE t.id = $1 AND tm.user_id = $2
        LIMIT 1`,
      [tenantId, actor.user_id],
    );
    const tenant = rows[0];
    if (!tenant) {
      throw new PlatformHttpError(
        404,
        "TENANT_NOT_FOUND",
        "Tenant not found",
        `/api/v1/tenants/${tenantId}`,
      );
    }
    return tenant;
  }

  async getDataResidency(actor: ActorContext, tenantId: string): Promise<TenantDataResidencyView> {
    const instance = dataResidencyInstance(tenantId);
    requireOwnTenant(actor, tenantId, instance);
    const rows = await this.db.queryTenant<TenantDataResidencyView>(
      actor.tenant_id,
      "SELECT data_residency FROM tenants WHERE id = $1",
      [actor.tenant_id],
    );
    return rows[0] ?? tenantNotFound(instance);
  }

  /**
   * Replaces the tenant's data residency. The If-Match check, the write and the
   * audit event share one transaction with the row locked, so a concurrent
   * writer cannot slip between the check and the update, and a change the audit
   * service did not record is rolled back rather than kept unaudited.
   */
  async setDataResidency(
    actor: ActorContext,
    tenantId: string,
    body: unknown,
    ifMatch: string | undefined,
  ): Promise<TenantDataResidencyView> {
    const instance = dataResidencyInstance(tenantId);
    requireOwnTenant(actor, tenantId, instance);
    const parsed = TenantDataResidencyBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new PlatformHttpError(
        400,
        "INVALID_DATA_RESIDENCY",
        "Body must be { data_residency: { allowed: string[1..32], legal_basis?: string } | null }",
        instance,
        parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      );
    }
    if (!ifMatch) {
      throw new ConcurrencyHttpError(428, "IF_MATCH_REQUIRED", "If-Match header required", instance);
    }
    return this.db.withTenant(actor.tenant_id, async (client) => {
      const current = await client.query<TenantDataResidencyView>(
        "SELECT data_residency FROM tenants WHERE id = $1 FOR UPDATE",
        [actor.tenant_id],
      );
      const before = current.rows[0] ?? tenantNotFound(instance);
      if (!ifMatchIncludes(ifMatch, computeEtag(before))) {
        throw new ConcurrencyHttpError(412, "ETAG_MISMATCH", "Resource changed since it was read", instance);
      }
      const after: TenantDataResidencyView = { data_residency: parsed.data.data_residency };
      await client.query("UPDATE tenants SET data_residency = $2 WHERE id = $1", [
        actor.tenant_id,
        after.data_residency === null ? null : JSON.stringify(after.data_residency),
      ]);
      await this.audit.recordEvent({
        tenant_id: actor.tenant_id,
        actor_type: "user",
        actor_ref: actor.user_id,
        action: "tenant.data_residency.update",
        target_type: "tenant",
        target_ref: actor.tenant_id,
        result: "success",
        reason_code: "",
        context_json: JSON.stringify({ scope: { before: before.data_residency, after: after.data_residency } }),
        occurred_at: new Date().toISOString(),
      });
      return after;
    });
  }
}

function dataResidencyInstance(tenantId: string): string {
  return `/api/v1/tenants/${tenantId}/data-residency`;
}

/** Residency is only ever read or written for the caller's own tenant. */
function requireOwnTenant(actor: ActorContext, tenantId: string, instance: string): void {
  if (tenantId !== actor.tenant_id) tenantNotFound(instance);
}

function tenantNotFound(instance: string): never {
  throw new PlatformHttpError(404, "TENANT_NOT_FOUND", "Tenant not found", instance);
}
