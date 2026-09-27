import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpException, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import {
  WorkflowNotFoundError,
  WorkflowReadService,
  WorkflowValidationError,
  type WorkflowStatus,
} from "./workflow-read.service";

interface UpdateWorkflowBody {
  readonly name?: string;
  readonly status?: WorkflowStatus;
  readonly dag?: unknown;
}

interface SimulateWorkflowBody {
  readonly input?: Record<string, unknown>;
}

interface CreateWorkflowBody {
  readonly goal?: string;
}

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
  if (workspaceId === null || workspaceId === undefined) {
    throw new HttpException(
      internalProblem(request.url, "Missing authenticated workspace context"),
      500,
    );
  }
  return workspaceId;
}

@Controller("api/v1/workflows")
export class WorkflowReadController {
  constructor(private readonly service: WorkflowReadService) {}

  @Post()
  async create(@Req() request: SessionGatewayRequest, @Body() body: CreateWorkflowBody) {
    const tenantId = requiredTenantId(request);
    const workspaceId = requiredWorkspaceId(request);
    try {
      return await this.service.createWorkflow({
        tenantId,
        workspaceId,
        name: body.goal ?? "",
      });
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Get()
  async list(
    @Req() request: SessionGatewayRequest,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    try {
      return await this.service.listWorkflows(
        requiredTenantId(request),
        requiredWorkspaceId(request),
        cursor,
        rawLimit === undefined ? 50 : Number(rawLimit),
      );
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: SessionGatewayRequest, @Param("id") workflowId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.getWorkflow(tenantId, workflowId);
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Get(":id/versions")
  async versions(
    @Req() request: SessionGatewayRequest,
    @Param("id") workflowId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    try {
      return await this.service.listVersions(
        requiredTenantId(request),
        workflowId,
        cursor,
        rawLimit === undefined ? 50 : Number(rawLimit),
      );
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Patch(":id")
  async update(
    @Req() request: SessionGatewayRequest,
    @Param("id") workflowId: string,
    @Body() body: UpdateWorkflowBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.updateWorkflow({
        tenantId,
        workflowId,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.dag === undefined ? {} : { dag: body.dag }),
      });
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Post(":id/actions/validate")
  async validate(@Req() request: SessionGatewayRequest, @Param("id") workflowId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.validateDraft(tenantId, workflowId);
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Post(":id/actions/compile")
  async compile(@Req() request: SessionGatewayRequest, @Param("id") workflowId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.compileWorkflow(tenantId, workflowId);
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Post(":id/actions/simulate")
  async simulate(
    @Req() request: SessionGatewayRequest,
    @Param("id") workflowId: string,
    @Body() body: SimulateWorkflowBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.simulateWorkflow(tenantId, workflowId, body.input ?? {});
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Post(":id/actions/activate")
  async activate(@Req() request: SessionGatewayRequest, @Param("id") workflowId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.activateWorkflow(tenantId, workflowId);
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Post(":id/actions/pause")
  async pause(@Req() request: SessionGatewayRequest, @Param("id") workflowId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.pauseWorkflow(tenantId, workflowId);
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }

  @Post(":id/actions/resume")
  async resume(@Req() request: SessionGatewayRequest, @Param("id") workflowId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return await this.service.resumeWorkflow(tenantId, workflowId);
    } catch (error: unknown) {
      throw mapWorkflowError(error, request.url);
    }
  }
}

function mapWorkflowError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof WorkflowNotFoundError) {
    return new HttpException(notFoundProblem(requestUrl, error.message), 404);
  }
  if (error instanceof WorkflowValidationError) {
    return new HttpException(badRequestProblem(requestUrl, error.message), 400);
  }
  if (error instanceof HttpException) {
    return error;
  }
  return new HttpException(
    internalProblem(requestUrl, "Workflow request could not be completed"),
    500,
  );
}

function instanceOrRoot(requestUrl: string | undefined): string {
  return requestUrl?.startsWith("/") ? requestUrl : "/";
}

function badRequestProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/workflow-validation",
    title: "Bad Request",
    status: 400,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "WORKFLOW_VALIDATION_FAILED",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "workflows.validation-failed",
  };
}

function notFoundProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/workflow-not-found",
    title: "Not Found",
    status: 404,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "WORKFLOW_NOT_FOUND",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "workflows.not-found",
  };
}

function internalProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return {
    type: "https://alter.dev/problems/workflow-internal",
    title: "Internal Server Error",
    status: 500,
    detail,
    instance: instanceOrRoot(requestUrl),
    error_code: "WORKFLOW_INTERNAL_ERROR",
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: "workflows.internal-error",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}` as `${typeof prefix}_${string}`;
}
