import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpException, Param, Post, Query, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import {
  ProjectNotFoundError,
  ProjectReadService,
  ProjectValidationError,
} from "./project-read.service";
import {
  ProjectDomainService,
  ProjectStateConflictError,
} from "./project-domain.service";

function requiredTenantId(request: SessionGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(
      internalProblem(request.url, "Missing authenticated tenant context"),
      500,
    );
  }
  return tenantId;
}

function requiredWorkspaceId(request: SessionGatewayRequest): string {
  const workspaceId = request.actorContext?.workspace_id;
  if (workspaceId === undefined || workspaceId === null) {
    throw new HttpException(
      internalProblem(request.url, "Missing authenticated workspace context"),
      500,
    );
  }
  return workspaceId;
}

function requiredString(body: unknown, field: string): string {
  const value = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[field]
    : undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectValidationError(`${field} is required`);
  }
  return value;
}

@Controller("api/v1/projects")
export class ProjectReadController {
  constructor(
    private readonly service: ProjectReadService,
    private readonly projects: ProjectDomainService,
  ) {}

  @Post()
  async create(@Req() request: SessionGatewayRequest, @Body() body: unknown) {
    try {
      return await this.projects.create(
        requiredTenantId(request),
        requiredWorkspaceId(request),
        requiredString(body, "brief"),
      );
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Get()
  async list(
    @Req() request: SessionGatewayRequest,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
    @Query("q") query?: string,
  ) {
    try {
      return await this.service.listProjects(
        requiredTenantId(request),
        requiredWorkspaceId(request),
        cursor,
        rawLimit === undefined ? 50 : Number(rawLimit),
        query,
      );
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: SessionGatewayRequest, @Param("id") projectId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.getProject(tenantId, projectId);
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Post(":id/actions/deploy")
  async deploy(@Req() request: SessionGatewayRequest, @Param("id") projectId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.createDeployment(tenantId, projectId);
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Get(":id/clarifications")
  async clarifications(@Req() request: SessionGatewayRequest, @Param("id") projectId: string) {
    try {
      return await this.projects.clarifications(requiredTenantId(request), projectId);
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Post(":id/clarifications/:clarificationId/answer")
  async answerClarification(
    @Req() request: SessionGatewayRequest,
    @Param("id") projectId: string,
    @Param("clarificationId") clarificationId: string,
    @Body() body: unknown,
  ) {
    try {
      return await this.projects.answerClarification(
        requiredTenantId(request),
        projectId,
        clarificationId,
        requiredString(body, "answer"),
      );
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Get(":id/plan")
  async plan(@Req() request: SessionGatewayRequest, @Param("id") projectId: string) {
    try {
      return await this.projects.plan(requiredTenantId(request), projectId);
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Post(":id/plan/actions/:action")
  async reviewPlan(
    @Req() request: SessionGatewayRequest,
    @Param("id") projectId: string,
    @Param("action") action: string,
  ) {
    if (action !== "approve" && action !== "reject" && action !== "request-changes") {
      throw mapProjectError(new ProjectValidationError("unsupported plan action"), request.url);
    }
    try {
      return await this.projects.reviewPlan(requiredTenantId(request), projectId, action);
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }

  @Post(":id/builds")
  async startBuild(@Req() request: SessionGatewayRequest, @Param("id") projectId: string) {
    try {
      return await this.projects.startBuild(requiredTenantId(request), projectId);
    } catch (error: unknown) {
      throw mapProjectError(error, request.url);
    }
  }
}

function mapProjectError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof ProjectNotFoundError) {
    return new HttpException(notFoundProblem(requestUrl, error.message), 404);
  }
  if (error instanceof ProjectValidationError) {
    return new HttpException(badRequestProblem(requestUrl, error.message), 400);
  }
  if (error instanceof ProjectStateConflictError) {
    return new HttpException(conflictProblem(requestUrl, error.message), 409);
  }
  if (error instanceof HttpException) {
    return error;
  }
  return new HttpException(
    internalProblem(requestUrl, "Project request could not be completed"),
    500,
  );
}

function conflictProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/project-state-conflict",
    title: "Conflict",
    status: 409,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "PROJECT_STATE_CONFLICT",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "projects.state-conflict",
  };
}

function instanceOrRoot(requestUrl: string | undefined): string {
  return requestUrl?.startsWith("/") ? requestUrl : "/";
}

function badRequestProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/project-validation",
    title: "Bad Request",
    status: 400,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "PROJECT_VALIDATION_FAILED",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "projects.validation-failed",
  };
}

function notFoundProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/project-not-found",
    title: "Not Found",
    status: 404,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "PROJECT_NOT_FOUND",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "projects.not-found",
  };
}

function internalProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/project-internal",
    title: "Internal Server Error",
    status: 500,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "PROJECT_INTERNAL_ERROR",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "projects.internal-error",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}` as `${typeof prefix}_${string}`;
}
