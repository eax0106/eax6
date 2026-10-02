import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import type { FastifyReply } from "fastify";

import { BudgetExceededError } from "../budgets/budget.service";
import { RunEstimateService } from "../budgets/run-estimate.service";
import {
  RunLauncherService,
  RunNotFoundError,
  RunStartFailedError,
  RunStateConflictError,
  RunValidationError,
  WorkflowNotFoundError,
  type RunRow,
} from "./run-launcher.service";
import {
  RunOutcomeService,
  RunOutcomeRunNotFoundError,
  RunOutcomeValidationError,
  type RunOutcomeRow,
} from "./run-outcome.service";

interface CreateRunBody {
  readonly workflow_id: string;
  readonly workflow_version_id?: string;
  readonly timeout_ms?: number;
}

interface RetryNodeBody {
  readonly node_key: string;
}

interface RetrySignalBody {
  readonly node_execution_id: string;
}

interface RunsQuery {
  readonly workflow_id?: string;
  readonly mode?: "workflow" | "project";
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

interface RunEstimateQuery {
  readonly workflow_id?: string;
  readonly workflow_version_id?: string;
}

function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(internalProblem(request.url, "Missing authenticated tenant context"), 500);
  }
  return tenantId;
}

function toRunResponse(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    project_id: row.project_id ?? null,
    workflow_version_id: row.workflow_version_id,
    // ENGINE-FIX-P5-1b: additive -- owning workspace, consumed by
    // platform-api's workspace-bound RBAC resolver.
    workspace_id: row.workspace_id ?? null,
    parent_kind: row.parent_kind,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    deadline_at: row.deadline_at ?? null,
    created_at: row.created_at,
  };
}

function toOutcomeResponse(row: RunOutcomeRow): Record<string, unknown> {
  return {
    run_id: row.run_id,
    mode: row.mode,
    eligible: row.eligible,
    verdict: row.verdict,
    human_rescue: row.human_rescue,
    critical_external_error: row.critical_external_error,
    gates_passed: row.gates_passed,
    gates_failed: row.gates_failed,
    recovery_count: row.recovery_count,
    human_repair_after_complete: row.human_repair_after_complete,
    decided_at: row.decided_at,
  };
}

@Controller("api/v1/runs")
export class RunsController {
  constructor(
    private readonly launcher: RunLauncherService,
    private readonly outcomes: RunOutcomeService,
    private readonly estimates: RunEstimateService,
  ) {}

  /** D4: what a run of this workflow would cost, shown before it starts. */
  @Get("estimate")
  async estimate(@Req() request: IdentityTenantGatewayRequest, @Query() query: RunEstimateQuery) {
    const tenantId = requiredTenantId(request);
    const workspaceId = request.actorContext?.workspace_id;
    if (workspaceId === null || workspaceId === undefined) {
      throw new HttpException(internalProblem(request.url, "Missing authenticated workspace context"), 500);
    }
    if (typeof query.workflow_id !== "string" || query.workflow_id.trim().length === 0) {
      throw badRequest(request.url, "workflow_id is required");
    }
    try {
      return await this.estimates.estimate(tenantId, workspaceId, query.workflow_id, query.workflow_version_id);
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: IdentityTenantGatewayRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: CreateRunBody,
  ) {
    const tenantId = requiredTenantId(request);
    if (typeof body?.workflow_id !== "string" || body.workflow_id.trim().length === 0) {
      throw badRequest(request.url, "workflow_id is required");
    }
    try {
      const run = await this.launcher.createRun(
        tenantId,
        body.workflow_id,
        body.workflow_version_id,
        undefined,
        body.timeout_ms === undefined ? {} : { timeoutMs: body.timeout_ms },
      );
      reply.header("location", `/api/v1/runs/${run.id}`);
      return toRunResponse(run);
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }

  @Get()
  async list(@Req() request: IdentityTenantGatewayRequest, @Query() query: RunsQuery) {
    const tenantId = requiredTenantId(request);
    try {
      const page = await this.launcher.listRuns(tenantId, {
        ...(query.workflow_id === undefined ? {} : { workflowId: query.workflow_id }),
        ...(query.mode === undefined ? {} : { mode: query.mode }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      return {
        data: page.data.map(toRunResponse),
        page: page.page,
      };
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: IdentityTenantGatewayRequest, @Param("id") runId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return toRunResponse(await this.launcher.getRun(tenantId, runId));
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }

  @Get(":id/outcome")
  async outcome(@Req() request: IdentityTenantGatewayRequest, @Param("id") runId: string) {
    const tenantId = requiredTenantId(request);
    try {
      const row = await this.outcomes.getByRunId(tenantId, runId);
      if (row === undefined) {
        throw notFound(
          request.url,
          `Run ${runId} has no recorded outcome yet`,
          "RUN_OUTCOME_NOT_FOUND",
          "runs.outcome-not-found",
        );
      }
      return toOutcomeResponse(row);
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }

  // Neither action creates anything, and openapi.json documents both as 200.
  // Without this they answer Nest's POST default of 201, which no spec here
  // could see: these tests call the method, not the route.
  @Post(":id/actions/cancel")
  @HttpCode(200)
  async cancel(@Req() request: IdentityTenantGatewayRequest, @Param("id") runId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return toRunResponse(await this.launcher.cancelRun(tenantId, runId));
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }

  @Post(":id/actions/retry-node")
  @HttpCode(200)
  async retryNode(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") runId: string,
    @Body() body: RetryNodeBody,
  ) {
    const tenantId = requiredTenantId(request);
    if (typeof body?.node_key !== "string" || body.node_key.trim().length === 0) {
      throw badRequest(request.url, "node_key is required");
    }
    try {
      return toRunResponse(await this.launcher.retryNode(tenantId, runId, body.node_key));
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }

  @Post(":id/actions/retry-signal")
  @HttpCode(204)
  async retrySignal(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") runId: string,
    @Body() body: RetrySignalBody,
  ) {
    const tenantIdInput = requiredTenantId(request);
    const tenantId = tenantIdInput.startsWith("ten_") ? tenantIdInput : `ten_${tenantIdInput}`;
    if (typeof body?.node_execution_id !== "string" || body.node_execution_id.trim().length === 0) {
      throw badRequest(request.url, "node_execution_id is required");
    }
    try {
      await this.launcher.retrySignal(tenantId, runId, body.node_execution_id);
    } catch (error: unknown) {
      throw mapRunError(error, request.url);
    }
  }
}

export function mapRunError(error: unknown, requestUrl: string | undefined): HttpException {

  if (error instanceof HttpException) return error;
  if (error instanceof RunValidationError) {
    return badRequest(requestUrl, error.message);
  }
  if (error instanceof RunNotFoundError) {
    return notFound(requestUrl, error.message, "RUN_NOT_FOUND", "runs.not-found");
  }
  if (error instanceof WorkflowNotFoundError) {
    return notFound(requestUrl, error.message, "WORKFLOW_NOT_FOUND", "runs.workflow-not-found");
  }
  if (error instanceof BudgetExceededError) {
    return new HttpException(
      problem(requestUrl, 409, "BUDGET_EXCEEDED", error.message, "runs.budget-exceeded", false),
      409,
    );
  }
  if (error instanceof RunStateConflictError) {
    return conflict(requestUrl, error.message);
  }
  if (error instanceof RunOutcomeValidationError) {
    return badRequest(requestUrl, error.message);
  }
  if (error instanceof RunOutcomeRunNotFoundError) {
    return notFound(requestUrl, error.message, "RUN_NOT_FOUND", "runs.not-found");
  }
  if (error instanceof RunStartFailedError) {
    return new HttpException(
      problem(requestUrl, 502, "RUN_START_FAILED", error.message, "runs.start-failed", true),
      502,
    );
  }
  return new HttpException(internalProblem(requestUrl, "Runs request could not be completed"), 500);
}

function badRequest(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 400, "RUNS_VALIDATION_FAILED", detail, "runs.validation-failed", false),
    400,
  );
}

function notFound(
  requestUrl: string | undefined,
  detail: string,
  errorCode: string,
  documentationKey: string,
): HttpException {
  return new HttpException(problem(requestUrl, 404, errorCode, detail, documentationKey, false), 404);
}

function conflict(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 409, "RUN_STATE_CONFLICT", detail, "runs.state-conflict", false),
    409,
  );
}

function internalProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return problem(requestUrl, 500, "RUNS_INTERNAL_ERROR", detail, "runs.internal-error", false);
}

function problem(
  requestUrl: string | undefined,
  status: number,
  errorCode: string,
  detail: string,
  documentationKey: string,
  retryable: boolean,
): ProblemDetails {
  const title =
    status === 400 ? "Bad Request"
    : status === 404 ? "Not Found"
    : status === 409 ? "Conflict"
    : status === 502 ? "Bad Gateway"
    : "Internal Server Error";
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    detail,
    instance: requestUrl?.startsWith("/") ? requestUrl : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable,
    field_errors: [],
    documentation_key: documentationKey,
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}` as `${typeof prefix}_${string}`;
}
