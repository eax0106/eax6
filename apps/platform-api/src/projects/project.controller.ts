import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { EngineResponse } from "../engine";
import { Idempotent } from "../idempotency";
import { ActorContext, RequirePermission, RequireWorkspaceRole } from "../rbac";
import type { ActorContextType } from "../rbac";
import { ProjectHttpError } from "./problem";
import { ProjectExceptionFilter } from "./project-exception.filter";
import {
  type PlanReviewAction,
  ProjectService,
} from "./project.service";
import type {
  EmptyProjectActionInput,
  ProjectActionResult,
  ProjectBuild,
  ProjectClarificationList,
  ProjectList,
  ProjectPlan,
  ProjectRecord,
  ProjectResource,
  RejectPlanInput,
  RequestPlanChangesInput,
} from "./types";
import {
  approvePlanSchema,
  clarificationAnswerSchema,
  createProjectSchema,
  parseProjectInput,
  rejectPlanSchema,
  requestPlanChangesSchema,
  startBuildSchema,
} from "./validation";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writeRoles = ["admin", "editor"] as const;
const actRoles = ["admin", "editor", "operator", "approver"] as const;
const buildRoles = ["admin", "editor", "operator"] as const;

@Controller("/api/v1/projects")
@UseFilters(ProjectExceptionFilter)
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

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
  ): Promise<ProjectResource> {
    const instance = "/api/v1/projects";
    return project(
      await this.projects.create(
        parseProjectInput(createProjectSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("projects:read")
  async list(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query("q") nameQuery?: string,
  ): Promise<ProjectList> {
    const instance = "/api/v1/projects";
    return project(
      await this.projects.list(
        cursor,
        limit,
        requireActor(actor, instance),
        traceparent,
        nameQuery,
      ),
      reply,
    );
  }

  @Get(":projectId")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("projects:read")
  async get(
    @Param("projectId") projectId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectRecord> {
    const instance = `/api/v1/projects/${projectId}`;
    return project(
      await this.projects.get(
        projectId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Get(":projectId/clarifications")
  @RequireWorkspaceRole(...readRoles)
  async clarifications(
    @Param("projectId") projectId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectClarificationList> {
    const instance = `/api/v1/projects/${projectId}/clarifications`;
    return project(
      await this.projects.clarifications(
        projectId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Post(":projectId/clarifications/:clarificationId/answer")
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  async answerClarification(
    @Param("projectId") projectId: string,
    @Param("clarificationId") clarificationId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectActionResult> {
    const instance =
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`;
    return project(
      await this.projects.answerClarification(
        projectId,
        clarificationId,
        parseProjectInput(clarificationAnswerSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get(":projectId/plan")
  @RequireWorkspaceRole(...readRoles)
  async plan(
    @Param("projectId") projectId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectPlan> {
    const instance = `/api/v1/projects/${projectId}/plan`;
    return project(
      await this.projects.plan(
        projectId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Post(":projectId/plan/actions/approve")
  @RequireWorkspaceRole(...actRoles)
  @Idempotent()
  approvePlan(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectActionResult> {
    return this.reviewPlan(
      projectId,
      "approve",
      body,
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":projectId/plan/actions/reject")
  @RequireWorkspaceRole(...actRoles)
  @Idempotent()
  rejectPlan(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectActionResult> {
    return this.reviewPlan(
      projectId,
      "reject",
      body,
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":projectId/plan/actions/request-changes")
  @RequireWorkspaceRole(...actRoles)
  @Idempotent()
  requestPlanChanges(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectActionResult> {
    return this.reviewPlan(
      projectId,
      "request-changes",
      body,
      actor,
      traceparent,
      idempotencyKey,
      reply,
    );
  }

  @Post(":projectId/builds")
  @HttpCode(202)
  @RequireWorkspaceRole(...buildRoles)
  @Idempotent()
  async startBuild(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProjectBuild> {
    const instance = `/api/v1/projects/${projectId}/builds`;
    return project(
      await this.projects.startBuild(
        projectId,
        parseProjectInput(startBuildSchema, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  private async reviewPlan(
    projectId: string,
    action: PlanReviewAction,
    body: unknown,
    actor: ActorContextType | undefined,
    traceparent: string | undefined,
    idempotencyKey: string | undefined,
    reply: FastifyReply,
  ): Promise<ProjectActionResult> {
    const instance =
      `/api/v1/projects/${projectId}/plan/actions/${action}`;
    return project(
      await this.projects.reviewPlan(
        projectId,
        action,
        parseReviewInput(action, body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }
}

function parseReviewInput(
  action: PlanReviewAction,
  body: unknown,
  instance: string,
): EmptyProjectActionInput | RejectPlanInput | RequestPlanChangesInput {
  if (action === "approve") {
    return parseProjectInput(approvePlanSchema, body, instance);
  }
  if (action === "reject") {
    return parseProjectInput(rejectPlanSchema, body, instance);
  }
  return parseProjectInput(requestPlanChangesSchema, body, instance);
}

function requireActor(
  actor: ActorContextType | undefined,
  instance: string,
): ActorContextType {
  if (!actor) {
    throw new ProjectHttpError(
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
