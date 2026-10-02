import { Body, Controller, HttpException, Param, Post, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import { randomUUID } from "node:crypto";
import {
  DeploymentConcurrencyError,
  WorkflowLifecycleService,
  DeploymentNotFoundError,
  DeploymentStateTransitionError,
  DeploymentValidationError,
  ReleaseGateFailedError,
} from "./workflow-lifecycle.service";

interface VersionBody {
  readonly workflowVersionId?: string;
}

interface CanaryBody extends VersionBody {
  readonly trafficPercent?: number;
}

function tenantId(request: IdentityTenantGatewayRequest): string {
  const value = request.actorContext?.tenant_id;
  if (value === undefined) {
    throw new HttpException(
      problem(
        request.url ?? "/",
        500,
        "WORKFLOW_DEPLOYMENT_INTERNAL_ERROR",
        "Missing authenticated tenant context",
      ),
      500,
    );
  }
  return value;
}

@Controller("api/v1/workflows")
export class WorkflowDeploymentController {
  constructor(private readonly deployments: WorkflowLifecycleService) {}

  @Post(":workflowId/actions/test-version")
  async testVersion(@Req() request: IdentityTenantGatewayRequest, @Param("workflowId") workflowId: string, @Body() body: VersionBody) {
    try {
      if (typeof body?.workflowVersionId !== "string") throw new DeploymentValidationError("workflowVersionId is required");
      return await this.deployments.testVersion({ tenant_id: tenantId(request), workflow_id: workflowId, workflow_version_id: body.workflowVersionId });
    } catch (error: unknown) { throw mapError(error, request.url ?? "/"); }
  }

  @Post(":workflowId/actions/promote-version")
  async promote(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("workflowId") workflowId: string,
    @Body() body: VersionBody,
  ) {
    const instance = `/api/v1/workflows/${workflowId}/actions/promote-version`;
    try {
      if (typeof body?.workflowVersionId !== "string") {
        throw new DeploymentValidationError("workflowVersionId is required");
      }
      return await this.deployments.promoteVersion({
        tenant_id: tenantId(request),
        workflow_id: workflowId,
        workflow_version_id: body.workflowVersionId,
      });
    } catch (error: unknown) {
      throw mapError(error, request.url ?? instance);
    }
  }

  @Post(":workflowId/actions/start-canary")
  async startCanary(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("workflowId") workflowId: string,
    @Body() body: CanaryBody,
  ) {
    const instance = `/api/v1/workflows/${workflowId}/actions/start-canary`;
    try {
      if (typeof body?.workflowVersionId !== "string") {
        throw new DeploymentValidationError("workflowVersionId is required");
      }
      if (typeof body.trafficPercent !== "number") {
        throw new DeploymentValidationError("trafficPercent is required");
      }
      return await this.deployments.startCanary({
        tenant_id: tenantId(request),
        workflow_id: workflowId,
        workflow_version_id: body.workflowVersionId,
        traffic_percent: body.trafficPercent,
      });
    } catch (error: unknown) {
      throw mapError(error, request.url ?? instance);
    }
  }

  @Post(":workflowId/actions/rollback")
  async rollback(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("workflowId") workflowId: string,
    @Body() body: VersionBody,
  ) {
    const instance = `/api/v1/workflows/${workflowId}/actions/rollback`;
    try {
      if (typeof body?.workflowVersionId !== "string") {
        throw new DeploymentValidationError("workflowVersionId is required");
      }
      return await this.deployments.rollbackVersion({
        tenant_id: tenantId(request),
        workflow_id: workflowId,
        target_version_id: body.workflowVersionId,
      });
    } catch (error: unknown) {
      throw mapError(error, request.url ?? instance);
    }
  }
}

function mapError(error: unknown, requestUrl: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof DeploymentValidationError) {
    return new HttpException(problem(requestUrl, 400, "WORKFLOW_DEPLOYMENT_VALIDATION_FAILED", error.message), 400);
  }
  if (error instanceof DeploymentNotFoundError) {
    return new HttpException(problem(requestUrl, 404, "WORKFLOW_DEPLOYMENT_NOT_FOUND", error.message), 404);
  }
  if (error instanceof ReleaseGateFailedError) {
    return new HttpException(
      problem(requestUrl, 409, "WORKFLOW_DEPLOYMENT_RELEASE_GATE_FAILED", error.message),
      409,
    );
  }
  if (error instanceof DeploymentStateTransitionError || error instanceof DeploymentConcurrencyError) {
    return new HttpException(problem(requestUrl, 409, "WORKFLOW_DEPLOYMENT_CONFLICT", error.message), 409);
  }
  return new HttpException(problem(requestUrl, 500, "WORKFLOW_DEPLOYMENT_INTERNAL_ERROR", "Workflow deployment request could not be completed"), 500);
}

function problem(requestUrl: string, status: number, errorCode: string, detail: string): ProblemDetails {
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Internal Server Error",
    status,
    detail,
    instance: requestUrl.startsWith("/") ? requestUrl : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}` as `${typeof prefix}_${string}`;
}
