import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { EngineResponse } from "../engine";
import { EtagConstrained, EtagResponseInterceptor } from "../concurrency";
import { Idempotent } from "../idempotency";
import { ActorContext, RequireWorkspaceRole } from "../rbac";
import type { ActorContextType } from "../rbac";
import { WorkflowHttpError } from "./problem";
import type {
  WorkflowActionResult,
  WorkflowList,
  WorkflowResource,
  WorkflowVersionList,
} from "./types";
import {
  createWorkflowSchema,
  emptyActionSchema,
  parseWorkflowInput,
  saveCanvasSchema,
  simulateWorkflowSchema,
  replaceTemplateVariablesSchema,
  setTemplateVariableValueSchema,
  startCanarySchema,
  workflowVersionActionSchema,
} from "./validation";
import { WorkflowExceptionFilter } from "./workflow-exception.filter";
import { WorkflowService } from "./workflow.service";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writeRoles = ["admin", "editor"] as const;
const operateRoles = ["admin", "editor", "operator"] as const;

@Controller("/api/v1/workflows")
@UseFilters(WorkflowExceptionFilter)
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService) {}

  @Post()
  @HttpCode(201)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  async create(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowResource> {
    const instance = "/api/v1/workflows";
    const result = await this.workflows.create(
      parseWorkflowInput(createWorkflowSchema, body, instance),
      requireActor(actor, instance),
      traceparent,
      idempotencyKey!,
    );
    return project(result, reply);
  }

  @Get()
  @RequireWorkspaceRole(...readRoles)
  async list(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowList> {
    return project(
      await this.workflows.list(
        cursor,
        limit,
        requireActor(actor, "/api/v1/workflows"),
        traceparent,
      ),
      reply,
    );
  }

  @Get(":workflowId")
  @RequireWorkspaceRole(...readRoles)
  @UseInterceptors(EtagResponseInterceptor)
  async get(
    @Param("workflowId") workflowId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowResource> {
    return project(
      await this.workflows.get(
        workflowId,
        requireActor(actor, `/api/v1/workflows/${workflowId}`),
        traceparent,
      ),
      reply,
    );
  }

  @Patch(":workflowId")
  @RequireWorkspaceRole(...writeRoles)
  @EtagConstrained()
  @Idempotent()
  async saveCanvas(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowResource> {
    const instance = `/api/v1/workflows/${workflowId}`;
    return project(
      await this.workflows.saveCanvas(
        workflowId,
        parseWorkflowInput(saveCanvasSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
        ifMatch!,
      ),
      reply,
    );
  }

  @Get(":workflowId/versions")
  @RequireWorkspaceRole(...readRoles)
  async versions(
    @Param("workflowId") workflowId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowVersionList> {
    return project(
      await this.workflows.versions(
        workflowId,
        cursor,
        limit,
        requireActor(actor, `/api/v1/workflows/${workflowId}/versions`),
        traceparent,
      ),
      reply,
    );
  }

  @Post(":workflowId/actions/validate")
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  validate(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    return this.action(
      workflowId,
      "validate",
      parseWorkflowInput(
        emptyActionSchema,
        body,
        `/api/v1/workflows/${workflowId}/actions/validate`,
      ),
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":workflowId/actions/compile")
  @HttpCode(202)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  compile(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    return this.action(
      workflowId,
      "compile",
      parseWorkflowInput(
        emptyActionSchema,
        body,
        `/api/v1/workflows/${workflowId}/actions/compile`,
      ),
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":workflowId/actions/simulate")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  simulate(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    return this.action(
      workflowId,
      "simulate",
      parseWorkflowInput(
        simulateWorkflowSchema,
        body,
        `/api/v1/workflows/${workflowId}/actions/simulate`,
      ),
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":workflowId/actions/activate")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  activate(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    return this.emptyLifecycle(
      workflowId,
      "activate",
      body,
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":workflowId/actions/pause")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  pause(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    return this.emptyLifecycle(
      workflowId,
      "pause",
      body,
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":workflowId/actions/resume")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  resume(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    return this.emptyLifecycle(
      workflowId,
      "resume",
      body,
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  // A deployment starts here: promote-version and start-canary below both
  // refuse a version that has not been tested, and nothing exposed this.
  @Post(":workflowId/actions/test-version")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  async testVersion(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/actions/test-version`;
    return project(
      await this.workflows.testVersion(
        workflowId,
        parseWorkflowInput(workflowVersionActionSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post(":workflowId/actions/promote-version")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  async promoteVersion(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/actions/promote-version`;
    return project(
      await this.workflows.promoteVersion(
        workflowId,
        parseWorkflowInput(workflowVersionActionSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post(":workflowId/actions/start-canary")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  async startCanary(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/actions/start-canary`;
    return project(
      await this.workflows.startCanary(
        workflowId,
        parseWorkflowInput(startCanarySchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post(":workflowId/actions/rollback")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  async rollback(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/actions/rollback`;
    return project(
      await this.workflows.rollback(
        workflowId,
        parseWorkflowInput(workflowVersionActionSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get(":workflowId/template-variables")
  @RequireWorkspaceRole(...readRoles)
  async templateVariables(
    @Param("workflowId") workflowId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/template-variables`;
    return project(
      await this.workflows.templateVariables(
        workflowId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Put(":workflowId/template-variables")
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  async replaceTemplateVariables(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/template-variables`;
    return project(
      await this.workflows.replaceTemplateVariables(
        workflowId,
        parseWorkflowInput(replaceTemplateVariablesSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Put(":workflowId/template-variables/:name/value")
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  async setTemplateVariableValue(
    @Param("workflowId") workflowId: string,
    @Param("name") name: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/template-variables/${name}/value`;
    return project(
      await this.workflows.setTemplateVariableValue(
        workflowId,
        name,
        parseWorkflowInput(setTemplateVariableValueSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  private emptyLifecycle(
    workflowId: string,
    action: "activate" | "pause" | "resume",
    body: unknown,
    actor: ActorContextType | undefined,
    traceparent: string | undefined,
    idempotencyKey: string | undefined,
    reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/actions/${action}`;
    return this.action(
      workflowId,
      action,
      parseWorkflowInput(emptyActionSchema, body, instance),
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  private async action(
    workflowId: string,
    action:
      | "validate"
      | "compile"
      | "simulate"
      | "activate"
      | "pause"
      | "resume",
    input: Parameters<WorkflowService["action"]>[2],
    actor: ActorContextType | undefined,
    traceparent: string | undefined,
    idempotencyKey: string | undefined,
    reply: FastifyReply,
  ): Promise<WorkflowActionResult> {
    const instance = `/api/v1/workflows/${workflowId}/actions/${action}`;
    return project(
      await this.workflows.action(
        workflowId,
        action,
        input,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }
}

function requireActor(
  actor: ActorContextType | undefined,
  instance: string,
): ActorContextType {
  if (!actor) {
    throw new WorkflowHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated actor required",
      instance,
    );
  }
  return actor;
}

function project<T>(response: EngineResponse<T>, reply: FastifyReply): T {
  reply.status(response.status);
  if (response.location) reply.header("Location", response.location);
  if (response.requestId) reply.header("request_id", response.requestId);
  if (response.traceId) reply.header("trace_id", response.traceId);
  return response.body;
}
