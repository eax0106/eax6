import { v7 as uuidv7 } from "uuid";
import type { AuditEventHandler } from "@alterx/shared-clients";
import type { PlatformDb } from "../signup/platform-db";
import type { ActorContextType } from "../rbac";
import { WorkspaceExportHttpError } from "./problem";
import { parseExportId, parseExportWorkspaceId } from "./validation";
import type { ExportStatus, WorkspaceExportArchive, WorkspaceExportView } from "./types";

const EXPORT_ID_PREFIX = "exp_";

interface ExportRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly status: string;
  readonly archive: unknown;
  readonly failure_reason: string | null;
  readonly requested_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date | null;
}

/**
 * Durable workspace export records (D2, C74). Request is a workspace-admin
 * mutation, audited in the same transaction; status and download are reads
 * scoped by row security to the tenant and by the workspace check below.
 * The archive itself is built by the system-jobs runner, never here.
 */
export class WorkspaceExportService {
  constructor(
    private readonly db: PlatformDb,
    private readonly audit: AuditEventHandler,
  ) {}

  async request(actor: ActorContextType, workspaceId: string): Promise<WorkspaceExportView> {
    const instance = `/api/v1/workspaces/${workspaceId}/exports`;
    const workspace = parseExportWorkspaceId(workspaceId, instance);
    return this.db.withTenant(actor.tenant_id, async (client) => {
      const rows = await client.query<ExportRow>(
        `INSERT INTO workspace_exports (id, tenant_id, workspace_id, status, requested_by)
         VALUES ($1, $2, $3, 'requested', $4)
         RETURNING id, workspace_id, status, archive, failure_reason, requested_at, updated_at, expires_at`,
        [uuidv7(), actor.tenant_id, workspace, actor.user_id],
      );
      const row = rows.rows[0];
      if (!row) {
        throw new WorkspaceExportHttpError(500, "EXPORT_NOT_CREATED", "Export request could not be recorded", instance);
      }
      await this.audit.recordEvent({
        tenant_id: actor.tenant_id,
        actor_type: "user",
        actor_ref: actor.user_id,
        action: "workspace.exports.request",
        target_type: "workspace",
        target_ref: workspace,
        result: "success",
        reason_code: "",
        context_json: JSON.stringify({ export_id: `${EXPORT_ID_PREFIX}${row.id}` }),
        occurred_at: new Date().toISOString(),
      });
      return toView(row);
    });
  }

  async list(actor: ActorContextType, workspaceId: string): Promise<WorkspaceExportView[]> {
    const instance = `/api/v1/workspaces/${workspaceId}/exports`;
    const workspace = parseExportWorkspaceId(workspaceId, instance);
    const rows = await this.db.queryTenant<ExportRow>(
      actor.tenant_id,
      `SELECT id, workspace_id, status, archive, failure_reason, requested_at, updated_at, expires_at
         FROM workspace_exports
        WHERE tenant_id = $1 AND workspace_id = $2
        ORDER BY requested_at DESC
        LIMIT 50`,
      [actor.tenant_id, workspace],
    );
    return rows.map(toView);
  }

  async get(actor: ActorContextType, workspaceId: string, exportId: string): Promise<WorkspaceExportView> {
    const instance = `/api/v1/workspaces/${workspaceId}/exports/${exportId}`;
    const workspace = parseExportWorkspaceId(workspaceId, instance);
    const bare = parseExportId(exportId, instance).slice(EXPORT_ID_PREFIX.length);
    const rows = await this.db.queryTenant<ExportRow>(
      actor.tenant_id,
      `SELECT id, workspace_id, status, archive, failure_reason, requested_at, updated_at, expires_at
         FROM workspace_exports
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [actor.tenant_id, workspace, bare],
    );
    const row = rows[0];
    if (!row) {
      throw new WorkspaceExportHttpError(404, "EXPORT_NOT_FOUND", "Export not found", instance);
    }
    return toView(row);
  }

  /**
   * The ready archive for download. Ready and unexpired only: anything else
   * is not-found (never, expired, failed), so a failure is never served as
   * an empty download.
   */
  async download(actor: ActorContextType, workspaceId: string, exportId: string): Promise<WorkspaceExportArchive> {
    const instance = `/api/v1/workspaces/${workspaceId}/exports/${exportId}/download`;
    const workspace = parseExportWorkspaceId(workspaceId, instance);
    const bare = parseExportId(exportId, instance).slice(EXPORT_ID_PREFIX.length);
    const rows = await this.db.queryTenant<ExportRow>(
      actor.tenant_id,
      `SELECT id, workspace_id, status, archive, failure_reason, requested_at, updated_at, expires_at
         FROM workspace_exports
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3`,
      [actor.tenant_id, workspace, bare],
    );
    const row = rows[0];
    if (!row || row.status !== "ready") {
      throw new WorkspaceExportHttpError(404, "EXPORT_NOT_FOUND", "Export not found", instance);
    }
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
      throw new WorkspaceExportHttpError(410, "EXPORT_EXPIRED", "Export expired; request a new one", instance);
    }
    if (row.archive === null || typeof row.archive !== "object") {
      throw new WorkspaceExportHttpError(500, "EXPORT_MALFORMED", "Stored export archive is malformed", instance);
    }
    return row.archive as WorkspaceExportArchive;
  }
}

function toView(row: ExportRow): WorkspaceExportView {
  return {
    id: `${EXPORT_ID_PREFIX}${row.id}`,
    workspaceId: `ws_${row.workspace_id}`,
    status: row.status as ExportStatus,
    failureReason: row.failure_reason,
    requestedAt: row.requested_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}
