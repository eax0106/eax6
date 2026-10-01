import type { AuditEventHandler } from "@alterx/shared-clients";
import type { AuditEventsClient } from "../engine/audit-events-client";
import type { SystemNotificationStore } from "../notifications/system-notification-store";
import { PlatformDb } from "../signup/platform-db";

export interface WorkspaceErasureRunResult {
  readonly tenants: number;
  readonly tenantsFailed: number;
  readonly workspacesErased: number;
  readonly workspacesFailed: number;
}

/**
 * D2: erases every workspace whose undo window has ended. Each erasure goes
 * through audit-service's deletion orchestrator, the same locate, purge and
 * verify path as a tenant's erasure; platform-api's own share removes the
 * workspace row, so a verified erasure needs no further write here. A failed
 * erasure leaves the workspace pending and is retried on the next pass.
 */
export class WorkspaceErasureRunner {
  constructor(
    private readonly tenants: Pick<SystemNotificationStore, "listActiveTenantIds">,
    private readonly db: PlatformDb,
    private readonly erasure: Pick<AuditEventsClient, "executeWorkspaceErasure">,
    private readonly audit: AuditEventHandler,
  ) {}

  async run(now: Date = new Date()): Promise<WorkspaceErasureRunResult> {
    const tenantIds = await this.tenants.listActiveTenantIds();
    let tenantsFailed = 0;
    let workspacesErased = 0;
    let workspacesFailed = 0;
    for (const tenantId of tenantIds) {
      let due: readonly { id: string }[];
      try {
        due = await this.db.queryTenant<{ id: string }>(
          tenantId,
          `SELECT id::text AS id FROM workspaces
            WHERE tenant_id = $1 AND status = 'pending_deletion' AND deletion_due_at <= $2
            ORDER BY deletion_due_at`,
          [tenantId, now.toISOString()],
        );
      } catch {
        tenantsFailed += 1;
        continue;
      }
      for (const { id } of due) {
        try {
          const result = await this.erasure.executeWorkspaceErasure(`ten_${tenantId}`, `ws_${id}`);
          await this.audit.recordEvent({
            tenant_id: tenantId,
            actor_type: "system",
            actor_ref: "system:platform-jobs",
            action: "workspace.deletion.erase",
            target_type: "workspace",
            target_ref: id,
            result: "success",
            reason_code: "",
            context_json: JSON.stringify({ manifest_id: result.manifestId }),
            occurred_at: new Date().toISOString(),
          });
          workspacesErased += 1;
        } catch (error: unknown) {
          workspacesFailed += 1;
          console.error("workspace erasure failed; it stays pending and is retried", {
            workspace_id: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return { tenants: tenantIds.length, tenantsFailed, workspacesErased, workspacesFailed };
  }
}
