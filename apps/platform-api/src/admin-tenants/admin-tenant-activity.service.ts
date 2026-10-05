import { TenantDetailActivitySchema, type TenantDetailActivity } from "@alterx/contracts";
import { AdminAuditService } from "../admin-audit";
import { TenantActivityClient } from "../engine";
import { AdminTenantsRepository } from "./admin-tenants.repository";
import { AdminTenantHttpError } from "./problem";

export class AdminTenantActivityService {
  constructor(private readonly repository: AdminTenantsRepository, private readonly activity: TenantActivityClient,
    private readonly audit: AdminAuditService, private readonly now: () => Date = () => new Date()) {}

  async read(tenantId: string, staffId: string): Promise<TenantDetailActivity> {
    const instance = `/api/v1/admin/tenants/${tenantId}/activity`;
    const members = await this.repository.members(tenantId);
    if (!members) throw new AdminTenantHttpError(404, "ADMIN_TENANT_NOT_FOUND", "Tenant not found", instance);
    const end = this.now();
    const window = { tenant_id: tenantId, start_at: new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), end_at: end.toISOString() };
    const [engine, spend] = await Promise.all([this.activity.activity(window), this.activity.spend(window)]);
    const result = TenantDetailActivitySchema.parse({ ...engine, members, spend });
    await this.audit.record({ tenantId, actorType: "admin", actorRef: staffId, action: "tenant.activity.read", targetType: "tenant", targetRef: tenantId, scope: "tenant:read" });
    return result;
  }
}
