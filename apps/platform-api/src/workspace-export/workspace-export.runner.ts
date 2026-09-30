import { randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { createSystemCallerContext } from "../system-jobs/system-caller";
import type { EngineClient } from "../engine/engine-client";
import type { EngineCallerContext } from "../engine/types";
import type { ActorContextType } from "../rbac";
import type { AdsService } from "../ads/ads.service";
import { SystemNotificationStore } from "../notifications/system-notification-store";
import type { PlatformDb } from "../signup/platform-db";
import type { WorkspaceExportArchive, WorkspaceExportMember } from "./types";

export interface WorkspaceExportRunResult {
  readonly tenants: number;
  readonly tenantsFailed: number;
  readonly exportsProcessed: number;
  readonly exportsFailed: number;
}

interface PendingExport {
  readonly id: string;
  readonly workspace_id: string;
  readonly requested_by: string;
}

type ExportCollection = "workflows" | "workflow_versions" | "runs";

/** Pages per collection before a runaway export fails instead of growing forever. */
const MAX_PAGES_PER_COLLECTION = 250;

const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const RUNNING_STALE_MS = 60 * 60 * 1000;

/**
 * Builds requested workspace archives (D2, C74). For every live tenant it
 * takes that tenant's requested exports (plus running ones stale past an
 * hour, e.g. after a crash), reads every source scoped to the export's own
 * workspace -- workflows, versions and runs through the engine's
 * system-only export feed, members from the tenant's own membership rows,
 * knowledge through the ads relay as the still-admin requester -- and
 * stores the archive or records the failure with its reason. An upstream
 * failure is failed, never served as an empty archive. One export failing
 * never stops the rest.
 */
@Injectable()
export class WorkspaceExportRunner {
  private readonly logger = new Logger(WorkspaceExportRunner.name);

  constructor(
    private readonly tenants: SystemNotificationStore,
    private readonly db: PlatformDb,
    private readonly engine: EngineClient,
    private readonly ads: AdsService,
    private readonly audit: AuditEventHandler,
  ) {}

  async run(now: Date = new Date()): Promise<WorkspaceExportRunResult> {
    const tenantIds = await this.tenants.listActiveTenantIds();
    let tenantsFailed = 0;
    let exportsProcessed = 0;
    let exportsFailed = 0;
    for (const tenantId of tenantIds) {
      try {
        const result = await this.runTenant(tenantId, now);
        exportsProcessed += result.processed;
        exportsFailed += result.failed;
      } catch (error: unknown) {
        tenantsFailed += 1;
        this.logger.error({
          tenantId,
          message: "workspace export tenant pass failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { tenants: tenantIds.length, tenantsFailed, exportsProcessed, exportsFailed };
  }

  private async runTenant(tenantId: string, now: Date): Promise<{ processed: number; failed: number }> {
    const pending = await this.db.queryTenant<PendingExport>(
      tenantId,
      `SELECT id, workspace_id, requested_by
         FROM workspace_exports
        WHERE tenant_id = $1
          AND (status = 'requested'
            OR (status = 'running' AND updated_at < $2))`,
      [tenantId, new Date(now.getTime() - RUNNING_STALE_MS)],
    );
    let processed = 0;
    let failed = 0;
    for (const record of pending) {
      processed += 1;
      try {
        await this.processExport(tenantId, record, now);
      } catch (error: unknown) {
        failed += 1;
        this.logger.error({
          tenantId,
          exportId: record.id,
          message: "workspace export failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { processed, failed };
  }

  private async processExport(tenantId: string, record: PendingExport, now: Date): Promise<void> {
    const claimed = await this.db.queryTenant<{ id: string }>(
      tenantId,
      `UPDATE workspace_exports SET status = 'running', updated_at = $1, failure_reason = NULL
        WHERE tenant_id = $2 AND id = $3 AND status IN ('requested', 'running')
        RETURNING id`,
      [now.toISOString(), tenantId, record.id],
    );
    if (claimed.length === 0) return;
    try {
      const archive = await this.buildArchive(tenantId, record, now);
      await this.db.queryTenant(tenantId,
        `UPDATE workspace_exports
            SET status = 'ready', archive = $1, updated_at = $2, expires_at = $3
          WHERE tenant_id = $4 AND id = $5`,
        [JSON.stringify(archive), now.toISOString(), new Date(now.getTime() + EXPORT_TTL_MS).toISOString(), tenantId, record.id],
      );
      await this.auditExport(tenantId, record, "workspace.exports.ready", "success", "");
    } catch (error: unknown) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500) || "unknown error";
      await this.db.queryTenant(tenantId,
        `UPDATE workspace_exports
            SET status = 'failed', failure_reason = $1, archive = NULL, updated_at = $2
          WHERE tenant_id = $3 AND id = $4`,
        [reason, now.toISOString(), tenantId, record.id],
      );
      await this.auditExport(tenantId, record, "workspace.exports.failed", "error", reason);
    }
  }

  private async buildArchive(tenantId: string, record: PendingExport, now: Date): Promise<WorkspaceExportArchive> {
    const workspaceId = `ws_${record.workspace_id}`;
    const caller = createSystemCallerContext({ tenantId, traceparent: newTraceparent() });
    const members = await this.db.queryTenant<WorkspaceExportMember>(
      tenantId,
      `SELECT m.user_id AS "userId", u.email, u.display_name AS "name", m.role, 'workspace' AS "scope"
         FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.workspace_id = $2
        ORDER BY u.email NULLS LAST, m.user_id`,
      [tenantId, record.workspace_id],
    );
    const requester = await this.requireRequesterAdmin(tenantId, record);
    const workflows = await this.pageEngineCollection(caller, workspaceId, "workflows");
    const workflowVersions = await this.pageEngineCollection(caller, workspaceId, "workflow_versions");
    const runs = await this.pageEngineCollection(caller, workspaceId, "runs");
    const knowledgeSources = await this.pageKnowledge("sources", tenantId, requester);
    const knowledgeDocuments = await this.pageKnowledge("documents", tenantId, requester);
    return {
      exportedAt: now.toISOString(),
      workspaceId,
      workflows,
      workflowVersions,
      runs,
      knowledgeSources,
      knowledgeDocuments,
      members,
    };
  }

  private async pageEngineCollection(
    caller: EngineCallerContext,
    workspaceId: string,
    collection: ExportCollection,
  ): Promise<readonly unknown[]> {
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_COLLECTION; page += 1) {
      const query: `/api/v1/${string}` = `/api/v1/workspace-export-metadata?workspace_id=${encodeURIComponent(workspaceId)}&collection=${collection}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await this.engine.get<{ data: readonly unknown[]; page: { has_more: boolean; next_cursor: string | null } }>(
        query,
        caller,
      );
      rows.push(...response.body.data);
      if (!response.body.page.has_more) return rows;
      if (!response.body.page.next_cursor) {
        throw new Error(`export feed for ${collection} claims more without a cursor`);
      }
      cursor = response.body.page.next_cursor;
    }
    throw new Error(`export feed for ${collection} exceeds ${MAX_PAGES_PER_COLLECTION} pages`);
  }

  /**
   * The export carries what its requester could read: knowledge goes
   * through the ads relay as the requesting workspace admin, and the run
   * refuses first when they no longer hold that role.
   */
  private async requireRequesterAdmin(tenantId: string, record: PendingExport): Promise<ActorContextType> {
    const rows = await this.db.queryTenant<{ role: string }>(
      tenantId,
      `SELECT role FROM workspace_members WHERE tenant_id = $1 AND workspace_id = $2 AND user_id = $3`,
      [tenantId, record.workspace_id, record.requested_by],
    );
    if (rows[0]?.role !== "admin") {
      throw new Error("requester is no longer a workspace admin");
    }
    return {
      user_id: record.requested_by,
      tenant_id: tenantId,
      workspace_id: `ws_${record.workspace_id}`,
      roles: ["admin"],
      permissions: ["workflows:read", "runs:read", "knowledge:read"],
      session_id: `export-${record.id}`,
    };
  }

  private async pageKnowledge(
    kind: "sources" | "documents",
    tenantId: string,
    actor: ActorContextType,
  ): Promise<readonly unknown[]> {
    const rows: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_COLLECTION; page += 1) {
      const response = kind === "sources"
        ? await this.ads.sources({ cursor, limit: 200 }, actor, undefined)
        : await this.ads.documents({ cursor, limit: 200 }, actor, undefined);
      const body = response.body as { data: readonly unknown[]; page: { has_more: boolean; next_cursor: string | null } };
      rows.push(...body.data);
      if (!body.page.has_more) return rows;
      if (!body.page.next_cursor) {
        throw new Error(`knowledge ${kind} claims more without a cursor`);
      }
      cursor = body.page.next_cursor;
    }
    throw new Error(`knowledge ${kind} exceeds ${MAX_PAGES_PER_COLLECTION} pages`);
  }

  private async auditExport(
    tenantId: string,
    record: PendingExport,
    action: string,
    result: "success" | "error",
    reason: string,
  ): Promise<void> {
    await this.audit.recordEvent({
      tenant_id: tenantId,
      actor_type: "system",
      actor_ref: "system:platform-jobs",
      action,
      target_type: "workspace",
      target_ref: record.workspace_id,
      result,
      reason_code: reason,
      context_json: JSON.stringify({ request_id: `exp_${record.id}` }),
      occurred_at: new Date().toISOString(),
    });
  }
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
