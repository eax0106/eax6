import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Inject, Param, Patch, Post, Put, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { ZodError } from "zod";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowFolderError, WorkflowFoldersService } from "./workflow-folders.service";

@Controller("api/v1")
export class WorkflowFoldersController {
  constructor(@Inject(WorkflowFoldersService) private readonly folders: WorkflowFoldersService) {}
  @Get("workflow-folders")
  list(@Req() request: IdentityTenantGatewayRequest) {
    return this.respond(request, false, (tenant, workspace) => this.folders.list(tenant, workspace));
  }
  @Post("workflow-folders")
  create(@Req() request: IdentityTenantGatewayRequest, @Body() body: unknown) {
    return this.respond(request, true, (tenant, workspace) => this.folders.create(tenant, workspace, body));
  }
  @Patch("workflow-folders/:folderId")
  rename(@Req() request: IdentityTenantGatewayRequest, @Param("folderId") id: string, @Body() body: unknown, @Headers("if-match") ifMatch?: string) {
    return this.respond(request, true, (tenant, workspace) => this.folders.rename(tenant, workspace, id, body, ifMatch));
  }
  @Delete("workflow-folders/:folderId")
  @HttpCode(204)
  remove(@Req() request: IdentityTenantGatewayRequest, @Param("folderId") id: string, @Headers("if-match") ifMatch?: string) {
    return this.respond(request, true, (tenant, workspace) => this.folders.remove(tenant, workspace, id, ifMatch));
  }
  @Get("workflows/:workflowId/folder")
  placement(@Req() request: IdentityTenantGatewayRequest, @Param("workflowId") id: string) {
    return this.respond(request, false, (tenant, workspace) => this.folders.placement(tenant, workspace, id));
  }
  @Put("workflows/:workflowId/folder")
  move(@Req() request: IdentityTenantGatewayRequest, @Param("workflowId") id: string, @Body() body: unknown, @Headers("if-match") ifMatch?: string) {
    return this.respond(request, true, (tenant, workspace) => this.folders.move(tenant, workspace, id, body, ifMatch));
  }
  private async respond<T>(request: IdentityTenantGatewayRequest, write: boolean, operation: (tenant: string, workspace: string) => Promise<T>): Promise<T> {
    try {
      const actor = request.actorContext;
      if (!actor?.workspace_id || actor.actor_type !== "user" || !actor.user_id || !actor.permissions.includes(write ? "workflows:write" : "workflows:read")) {
        throw new WorkflowFolderError(403, "FOLDER_PERMISSION_DENIED", "Workspace permission is required");
      }
      return await operation(actor.tenant_id.startsWith("ten_") ? actor.tenant_id : `ten_${actor.tenant_id}`,
        actor.workspace_id.startsWith("ws_") ? actor.workspace_id : `ws_${actor.workspace_id}`);
    } catch (error: unknown) {
      const status = error instanceof WorkflowFolderError ? error.status : error instanceof ZodError ? 400 : 500;
      throw new HttpException({ type: "about:blank", title: "Folder request failed", status,
        detail: status === 500 ? "Folder request could not complete" : error instanceof Error ? error.message : "Invalid request",
        error_code: error instanceof WorkflowFolderError ? error.code : status === 400 ? "INVALID_FOLDER_REQUEST" : "INTERNAL_ERROR",
        instance: request.url, trace_id: `trc_${uuidV7()}`, request_id: `req_${uuidV7()}`, retryable: status >= 500,
      }, status);
    }
  }
}
