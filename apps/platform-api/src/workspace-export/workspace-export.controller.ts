import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { WorkspaceExportHttpError } from "./problem";
import type { WorkspaceExportArchive, WorkspaceExportView } from "./types";
import { parseExportBody } from "./validation";
import { WorkspaceExportService } from "./workspace-export.service";

const BASE = "/api/v1/workspaces";

/**
 * Workspace data exports (D2, C74). Request is a workspace-admin mutation
 * (idempotent via the shared interceptor); status and download read the
 * durable record. Downloads serve ready, unexpired archives only.
 */
@Controller(BASE)
export class WorkspaceExportController {
  constructor(private readonly exports: WorkspaceExportService) {}

  @Post(":workspaceId/exports")
  @HttpCode(201)
  @RequireWorkspaceRole("admin")
  @RequirePermission("workflows:read")
  @Idempotent()
  request(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<WorkspaceExportView> {
    const instance = `${BASE}/${workspaceId}/exports`;
    parseExportBody(body, instance);
    return this.exports.request(requireActor(actor, instance), workspaceId);
  }

  @Get(":workspaceId/exports")
  @RequireWorkspaceRole("admin")
  @RequirePermission("workflows:read")
  list(
    @Param("workspaceId") workspaceId: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<WorkspaceExportView[]> {
    const instance = `${BASE}/${workspaceId}/exports`;
    return this.exports.list(requireActor(actor, instance), workspaceId);
  }

  @Get(":workspaceId/exports/:exportId")
  @RequireWorkspaceRole("admin")
  @RequirePermission("workflows:read")
  get(
    @Param("workspaceId") workspaceId: string,
    @Param("exportId") exportId: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<WorkspaceExportView> {
    const instance = `${BASE}/${workspaceId}/exports/${exportId}`;
    return this.exports.get(requireActor(actor, instance), workspaceId, exportId);
  }

  @Get(":workspaceId/exports/:exportId/download")
  @RequireWorkspaceRole("admin")
  @RequirePermission("workflows:read")
  download(
    @Param("workspaceId") workspaceId: string,
    @Param("exportId") exportId: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<WorkspaceExportArchive> {
    const instance = `${BASE}/${workspaceId}/exports/${exportId}/download`;
    return this.exports.download(requireActor(actor, instance), workspaceId, exportId);
  }
}

function requireActor(actor: ActorContextType | undefined, instance: string): ActorContextType {
  if (!actor) throw new WorkspaceExportHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
  if (!actor.workspace_id) throw new WorkspaceExportHttpError(403, "EXPORT_WORKSPACE_REQUIRED", "Workspace actor context required", instance);
  return actor;
}
