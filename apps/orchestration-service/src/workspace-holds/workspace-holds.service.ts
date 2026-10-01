import { TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";

import type {
  OrchestrationTenantStore,
  OrchestrationTransactionLike,
} from "../runs/run-observability.service";

export class WorkspaceHoldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceHoldValidationError";
  }
}

/**
 * D2 workspace pending deletion. While a workspace waits out its undo window
 * the platform holds it here, and the trigger dispatcher starts no run for a
 * held workspace. Hold and release are idempotent.
 */
export class WorkspaceHoldsService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async hold(tenantIdInput: string, workspaceIdInput: string, heldBy: string): Promise<void> {
    const { tenantId, workspaceId } = ids(tenantIdInput, workspaceIdInput);
    await this.store.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO workspace_holds (tenant_id, workspace_id, held_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, workspace_id) DO NOTHING`,
        [tenantId, workspaceId, heldBy],
      ),
    );
  }

  async release(tenantIdInput: string, workspaceIdInput: string): Promise<void> {
    const { tenantId, workspaceId } = ids(tenantIdInput, workspaceIdInput);
    await this.store.withTenant(tenantId, (tx) =>
      tx.query("DELETE FROM workspace_holds WHERE tenant_id = $1 AND workspace_id = $2", [tenantId, workspaceId]),
    );
  }

  async isHeld(tenantIdInput: string, workspaceIdInput: string): Promise<boolean> {
    const { tenantId, workspaceId } = ids(tenantIdInput, workspaceIdInput);
    return this.store.withTenant(tenantId, (tx) => isWorkspaceHeld(tx, tenantId, workspaceId));
  }
}

/** For callers already inside a tenant transaction (the trigger dispatcher). Bare uuids. */
export async function isWorkspaceHeld(
  tx: OrchestrationTransactionLike,
  bareTenantId: string,
  bareWorkspaceId: string,
): Promise<boolean> {
  const result = await tx.query<{ held: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM workspace_holds WHERE tenant_id = $1 AND workspace_id = $2) AS held",
    [bareTenantId, bareWorkspaceId],
  );
  return result.rows[0]?.held === true;
}

function ids(tenantIdInput: string, workspaceIdInput: string): { tenantId: string; workspaceId: string } {
  const tenant = TenantIdSchema.safeParse(tenantIdInput.startsWith("ten_") ? tenantIdInput : `ten_${tenantIdInput}`);
  const workspace = WorkspaceIdSchema.safeParse(workspaceIdInput.startsWith("ws_") ? workspaceIdInput : `ws_${workspaceIdInput}`);
  if (!tenant.success) throw new WorkspaceHoldValidationError("tenant must be a ten_ prefixed UUIDv7");
  if (!workspace.success) throw new WorkspaceHoldValidationError("workspace must be a ws_ prefixed UUIDv7");
  return { tenantId: tenant.data.slice(4), workspaceId: workspace.data.slice(3) };
}
