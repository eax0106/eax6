import { TenantIdSchema } from "@alterx/contracts";
import { z } from "zod";

import type { OrchestrationTenantStore } from "../runs/run-observability.service";

export type DeploymentChangeRow = {
  readonly workflow_id: string;
  readonly workflow_version_id: string;
  readonly version: number;
  readonly workspace_id: string;
  readonly kind: "promoted" | "restored";
  readonly changed_at: string;
};

export class DeploymentChangesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentChangesValidationError";
  }
}

const MAX_ROWS = 200;

/** Versions that went live after a time, across the tenant's workspaces (D1 notifications). */
export class DeploymentChangesService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async since(tenantIdInput: string, changedAfter: string): Promise<readonly DeploymentChangeRow[]> {
    const parsed = TenantIdSchema.safeParse(tenantIdInput.startsWith("ten_") ? tenantIdInput : `ten_${tenantIdInput}`);
    if (!parsed.success) throw new DeploymentChangesValidationError("tenant must be a ten_ prefixed UUIDv7");
    if (!z.string().datetime({ offset: true }).safeParse(changedAfter).success) throw new DeploymentChangesValidationError("changed_after must be an ISO 8601 time");
    const tenantId = parsed.data.slice("ten_".length);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<DeploymentChangeRow>(
        `SELECT v.workflow_id, v.id AS workflow_version_id, v.version, w.workspace_id::text AS workspace_id,
                v.last_deploy_kind AS kind, v.last_deployed_at::text AS changed_at
           FROM workflow_versions v
           JOIN workflows w ON w.tenant_id = v.tenant_id AND w.id = v.workflow_id
          WHERE v.tenant_id = $1 AND v.last_deployed_at > $2::timestamptz
          ORDER BY v.last_deployed_at DESC, v.id
          LIMIT $3`,
        [tenantId, changedAfter, MAX_ROWS],
      );
      return result.rows.map((row) => ({ ...row, changed_at: new Date(row.changed_at).toISOString() }));
    });
  }
}
