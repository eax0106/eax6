import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Inject, Param, Patch, Post, Put, Res, UseFilters } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { WorkflowFolderIdSchema, WorkflowFolderInputSchema, WorkflowFolderListSchema, WorkflowFolderMoveSchema, WorkflowFolderPlacementSchema, WorkflowFolderSchema, WorkflowIdSchema } from "@alterx/contracts";
import { EngineClient, type EngineResponse } from "../engine";
import { Idempotent } from "../idempotency";
import { ActorContext, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { permissionsForRoles } from "../rbac/permissions";
import { WorkflowExceptionFilter } from "../workflows/workflow-exception.filter";
import { WorkflowHttpError } from "../workflows/problem";
import { parseWorkflowInput } from "../workflows/validation";
import { workflowCallerContext } from "../workflows/workflow.service";

const readers = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writers = ["admin", "editor"] as const;
function roles(actor: ActorContextType | undefined, write: boolean): ActorContextType {
  const current = actor?.workspaceRoles?.filter(binding => binding.workspaceId === actor.workspace_id).map(binding => binding.role) ?? [];
  if (!actor?.workspace_id || !current.some(role => (write ? writers : readers).some(allowed => role === allowed))) {
    throw new WorkflowHttpError(403, "FOLDER_PERMISSION_DENIED", "Workspace role is required", "/api/v1/workflow-folders");
  }
  return { ...actor, roles: current, permissions: permissionsForRoles(current) };
}
function resource(response: EngineResponse<unknown>, reply: FastifyReply, placement = false) {
  try {
    const data = placement ? WorkflowFolderPlacementSchema.parse(response.body) : WorkflowFolderSchema.parse(response.body);
    reply.status(response.status).header("ETag", data.etag);
    return data;
  } catch {
    throw new HttpException("Folder service returned an invalid resource", 503);
  }
}

@Controller("/api/v1")
@UseFilters(WorkflowExceptionFilter)
export class PlatformWorkflowFoldersController {
  constructor(@Inject(EngineClient) private readonly engine: EngineClient) {}

  @Get("workflow-folders")
  @RequireWorkspaceRole(...readers)
  async list(@ActorContext() actor?: ActorContextType, @Headers("traceparent") traceparent?: string) {
    const caller = roles(actor, false), path = "/api/v1/workflow-folders";
    const response = await this.engine.get(path, workflowCallerContext(caller, traceparent, path));
    return WorkflowFolderListSchema.parse({ data: response.body, canEdit: caller.roles.some(role => writers.some(allowed => role === allowed)) });
  }

  @Post("workflow-folders")
  @RequireWorkspaceRole(...writers)
  @Idempotent()
  async create(@Body() body: unknown, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") key: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const path = "/api/v1/workflow-folders";
    return resource(await this.engine.post(path, parseWorkflowInput(WorkflowFolderInputSchema, body, path), workflowCallerContext(roles(actor, true), traceparent, path), { idempotencyKey: key }), reply);
  }

  @Patch("workflow-folders/:folderId")
  @RequireWorkspaceRole(...writers)
  @Idempotent()
  async rename(@Param("folderId") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string, @Headers("if-match") etag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply) {
    const parsed = parseWorkflowInput(WorkflowFolderIdSchema, id, "/api/v1/workflow-folders"), path = `/api/v1/workflow-folders/${parsed}` as const;
    return resource(await this.engine.patch(path, parseWorkflowInput(WorkflowFolderInputSchema, body, path), workflowCallerContext(roles(actor, true), traceparent, path), { idempotencyKey: key, ifMatch: etag ?? "" }), reply);
  }

  @Delete("workflow-folders/:folderId")
  @HttpCode(204)
  @RequireWorkspaceRole(...writers)
  @Idempotent()
  async remove(@Param("folderId") id: string, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string, @Headers("if-match") etag?: string) {
    const parsed = parseWorkflowInput(WorkflowFolderIdSchema, id, "/api/v1/workflow-folders"), path = `/api/v1/workflow-folders/${parsed}` as const;
    await this.engine.delete(path, workflowCallerContext(roles(actor, true), traceparent, path), { idempotencyKey: key, ...(etag === undefined ? {} : { ifMatch: etag }) });
  }

  @Get("workflows/:workflowId/folder")
  @RequireWorkspaceRole(...readers)
  async placement(@Param("workflowId") id: string, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    const parsed = parseWorkflowInput(WorkflowIdSchema, id, "/api/v1/workflows"), path = `/api/v1/workflows/${parsed}/folder` as const;
    return resource(await this.engine.get(path, workflowCallerContext(roles(actor, false), traceparent, path)), reply, true);
  }

  @Put("workflows/:workflowId/folder")
  @RequireWorkspaceRole(...writers)
  @Idempotent()
  async move(@Param("workflowId") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string, @Headers("if-match") etag: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply) {
    const parsed = parseWorkflowInput(WorkflowIdSchema, id, "/api/v1/workflows"), path = `/api/v1/workflows/${parsed}/folder` as const;
    return resource(await this.engine.put(path, parseWorkflowInput(WorkflowFolderMoveSchema, body, path), workflowCallerContext(roles(actor, true), traceparent, path), { idempotencyKey: key, ...(etag === undefined ? {} : { ifMatch: etag }) }), reply, true);
  }
}
