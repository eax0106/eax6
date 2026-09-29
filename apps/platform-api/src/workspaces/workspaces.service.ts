import { v7 as uuidv7 } from "uuid";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { PlatformHttpError } from "../signup/problem";
import { bareWorkspaceId } from "./workspace-id";

export interface WorkspaceView {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  updatedAt: Date;
}

export class WorkspacesService {
  constructor(private readonly db: PlatformDb) {}

  list(actor: ActorContext): Promise<WorkspaceView[]> {
    return this.db.queryTenant<WorkspaceView>(
      actor.tenant_id,
      `SELECT id, tenant_id AS "tenantId", name, status,
              updated_at AS "updatedAt"
         FROM workspaces
        WHERE tenant_id = $1
        ORDER BY created_at`,
      [actor.tenant_id],
    );
  }

  async create(actor: ActorContext, name: string): Promise<WorkspaceView> {
    if (!name.trim()) {
      throw new PlatformHttpError(
        400,
        "WORKSPACE_NAME_REQUIRED",
        "Workspace name required",
        "/api/v1/workspaces",
      );
    }
    const rows = await this.db.queryTenant<WorkspaceView>(
      actor.tenant_id,
      `INSERT INTO workspaces (id, tenant_id, name, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, tenant_id AS "tenantId", name, status,
                 updated_at AS "updatedAt"`,
      // Crosses into the workflow/orchestration engine domain, which enforces
      // UUIDv7 bodies once "ws_" prefixed -- see signup.service.ts.
      [uuidv7(), actor.tenant_id, name.trim()],
    );
    return required(rows[0], "WORKSPACE_CREATE_FAILED", "/api/v1/workspaces");
  }

  async get(actor: ActorContext, workspaceId: string): Promise<WorkspaceView> {
    const id = bareWorkspaceId(workspaceId);
    if (id === undefined) {
      throw new PlatformHttpError(404, "WORKSPACE_NOT_FOUND", "WORKSPACE_NOT_FOUND", `/api/v1/workspaces/${workspaceId}`);
    }
    const rows = await this.db.queryTenant<WorkspaceView>(
      actor.tenant_id,
      `SELECT id, tenant_id AS "tenantId", name, status,
              updated_at AS "updatedAt"
         FROM workspaces
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [id, actor.tenant_id],
    );
    return required(
      rows[0],
      "WORKSPACE_NOT_FOUND",
      `/api/v1/workspaces/${workspaceId}`,
      404,
    );
  }

  async update(
    actor: ActorContext,
    workspaceId: string,
    name: string,
    ifMatch: string | undefined,
  ): Promise<WorkspaceView> {
    const current = await this.get(actor, workspaceId);
    if (!ifMatch) {
      throw new PlatformHttpError(
        428,
        "IF_MATCH_REQUIRED",
        "If-Match header required",
        `/api/v1/workspaces/${workspaceId}`,
      );
    }
    if (ifMatch !== workspaceEtag(current)) {
      throw new PlatformHttpError(
        412,
        "ETAG_MISMATCH",
        "Workspace changed since it was read",
        `/api/v1/workspaces/${workspaceId}`,
      );
    }
    const rows = await this.db.queryTenant<WorkspaceView>(
      actor.tenant_id,
      `UPDATE workspaces
          SET name = $1
        WHERE id = $2 AND tenant_id = $3
          -- The ETag carries milliseconds (a JS Date) while updated_at holds
          -- microseconds, so an exact comparison never matched and every
          -- rename answered 412. Compare at the precision the ETag has.
          AND date_trunc('milliseconds', updated_at) = $4
        RETURNING id, tenant_id AS "tenantId", name, status,
                  updated_at AS "updatedAt"`,
      [name.trim(), current.id, actor.tenant_id, current.updatedAt],
    );
    return required(
      rows[0],
      "ETAG_MISMATCH",
      `/api/v1/workspaces/${workspaceId}`,
      412,
    );
  }
}

export function workspaceEtag(workspace: WorkspaceView): string {
  return `"${new Date(workspace.updatedAt).toISOString()}"`;
}

function required<T>(
  value: T | undefined,
  errorCode: string,
  instance: string,
  status = 500,
): T {
  if (!value) {
    throw new PlatformHttpError(status, errorCode, errorCode, instance);
  }
  return value;
}
