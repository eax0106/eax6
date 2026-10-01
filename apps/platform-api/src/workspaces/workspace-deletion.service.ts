import { randomBytes, randomUUID } from "node:crypto";
import type { AuditEventHandler } from "@alterx/shared-clients";
import type { EngineCallerContext, EngineClient } from "../engine";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { PlatformHttpError } from "../signup/problem";
import { bareWorkspaceId } from "./workspace-id";

export interface WorkspaceDeletionView {
  id: string;
  name: string;
  status: string;
  deletionRequestedAt: Date | null;
  deletionDueAt: Date | null;
}

interface WorkspaceDeletionRow extends WorkspaceDeletionView {
  windowOpen: boolean;
}

const COLUMNS = `id, name, status,
  deletion_requested_at AS "deletionRequestedAt",
  deletion_due_at AS "deletionDueAt"`;

/**
 * D2 workspace pending deletion. Deleting a workspace takes a typed-name
 * confirmation and starts an undo window: the workspace is hidden, the engine
 * holds it so no run starts, and its data stays untouched until the window
 * ends. The owner or an admin can restore it within the window.
 *
 * Ordering keeps "no run starts" true across partial failures: the engine hold
 * is placed before the workspace is marked pending (and released again if the
 * mark fails), and on restore the workspace is made active before the hold is
 * released, so a failed release only leaves runs refused, and repeating the
 * restore releases it.
 */
export class WorkspaceDeletionService {
  constructor(
    private readonly db: PlatformDb,
    private readonly engine: EngineClient,
    private readonly audit: AuditEventHandler,
    private readonly windowDays: number,
  ) {}

  async requestDeletion(
    actor: ActorContext,
    workspaceId: string,
    confirmName: unknown,
  ): Promise<WorkspaceDeletionView> {
    const instance = `/api/v1/workspaces/${workspaceId}`;
    const id = bareWorkspaceId(workspaceId) ?? notFound(instance);
    const current = (await this.read(actor, id))[0] ?? notFound(instance);
    if (current.status === "pending_deletion") {
      throw new PlatformHttpError(409, "WORKSPACE_PENDING_DELETION", "Workspace is already pending deletion", instance);
    }
    if (typeof confirmName !== "string" || confirmName !== current.name) {
      throw new PlatformHttpError(
        400,
        "WORKSPACE_CONFIRM_NAME_MISMATCH",
        "Type the workspace name exactly to confirm deletion",
        instance,
      );
    }

    await this.engine.put(holdPath(id), {}, engineContext(actor, id), { idempotencyKey: randomUUID() });
    try {
      return await this.db.withTenant(actor.tenant_id, async (client) => {
        const updated = await client.query<WorkspaceDeletionView>(
          `UPDATE workspaces
              SET status = 'pending_deletion',
                  deletion_requested_at = now(),
                  deletion_due_at = now() + make_interval(days => $3),
                  deletion_requested_by = $4
            WHERE id = $1 AND tenant_id = $2 AND status <> 'pending_deletion'
            RETURNING ${COLUMNS}`,
          [id, actor.tenant_id, this.windowDays, actor.user_id],
        );
        const row = updated.rows[0];
        if (row === undefined) {
          throw new PlatformHttpError(409, "WORKSPACE_PENDING_DELETION", "Workspace is already pending deletion", instance);
        }
        await this.recordAudit(actor, id, "workspace.deletion.request", {
          deletion_due_at: new Date(row.deletionDueAt!).toISOString(),
        });
        return row;
      });
    } catch (error) {
      await this.engine
        .delete(holdPath(id), engineContext(actor, id), { idempotencyKey: randomUUID() })
        .catch((releaseError: unknown) => {
          console.error("workspace deletion: hold release after failed request failed", {
            workspace_id: id,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        });
      throw error;
    }
  }

  async restore(actor: ActorContext, workspaceId: string): Promise<WorkspaceDeletionView> {
    const instance = `/api/v1/workspaces/${workspaceId}/actions/restore`;
    const id = bareWorkspaceId(workspaceId) ?? notFound(instance);
    const restored = await this.db.withTenant(actor.tenant_id, async (client) => {
      const locked = await client.query<WorkspaceDeletionRow>(
        `SELECT ${COLUMNS}, (deletion_due_at > now()) AS "windowOpen"
           FROM workspaces WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, actor.tenant_id],
      );
      const row = locked.rows[0] ?? notFound(instance);
      // Already active: a previous restore committed but its hold release
      // failed. Fall through so the release below is retried.
      if (row.status !== "pending_deletion") return withoutWindow(row);
      if (!row.windowOpen) {
        throw new PlatformHttpError(409, "WORKSPACE_DELETION_WINDOW_ENDED", "The restore window has ended", instance);
      }
      const updated = await client.query<WorkspaceDeletionView>(
        `UPDATE workspaces
            SET status = 'active', deletion_requested_at = NULL,
                deletion_due_at = NULL, deletion_requested_by = NULL
          WHERE id = $1 AND tenant_id = $2
          RETURNING ${COLUMNS}`,
        [id, actor.tenant_id],
      );
      await this.recordAudit(actor, id, "workspace.deletion.restore", {});
      return updated.rows[0]!;
    });
    await this.engine.delete(holdPath(id), engineContext(actor, id), { idempotencyKey: randomUUID() });
    return restored;
  }

  private async read(actor: ActorContext, id: string): Promise<WorkspaceDeletionView[]> {
    return this.db.queryTenant<WorkspaceDeletionView>(
      actor.tenant_id,
      `SELECT ${COLUMNS} FROM workspaces WHERE id = $1 AND tenant_id = $2`,
      [id, actor.tenant_id],
    );
  }

  private async recordAudit(
    actor: ActorContext,
    workspaceId: string,
    action: string,
    context: Record<string, string>,
  ): Promise<void> {
    await this.audit.recordEvent({
      tenant_id: actor.tenant_id,
      actor_type: "user",
      actor_ref: actor.user_id,
      action,
      target_type: "workspace",
      target_ref: workspaceId,
      result: "success",
      reason_code: "",
      context_json: JSON.stringify(context),
      occurred_at: new Date().toISOString(),
    });
  }
}

function holdPath(bareId: string): `/api/v1/${string}` {
  return `/api/v1/workspace-holds/ws_${bareId}`;
}

function engineContext(actor: ActorContext, bareId: string): EngineCallerContext {
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: bareId,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1_000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
  };
}

function withoutWindow(row: WorkspaceDeletionRow): WorkspaceDeletionView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    deletionRequestedAt: row.deletionRequestedAt,
    deletionDueAt: row.deletionDueAt,
  };
}

function notFound(instance: string): never {
  throw new PlatformHttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found", instance);
}
