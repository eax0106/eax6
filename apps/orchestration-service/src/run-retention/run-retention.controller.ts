import { randomUUID } from "node:crypto";
import { Body, Controller, Get, Headers, HttpException, Put, Query, Req, Res } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import type { FastifyReply } from "fastify";

import {
  RunRetentionConfirmationRequiredError,
  RunRetentionService,
  RunRetentionStaleError,
  RunRetentionValidationError,
  type RunRetentionSetting,
} from "./run-retention.service";

const RUN_RETENTION_WRITE = "runs:retention:write";

/**
 * D2: the caller's workspace run-history retention. platform-api relays these
 * routes for the web; the workspace comes from the actor token.
 */
@Controller("api/v1/run-retention")
export class RunRetentionController {
  constructor(private readonly retention: RunRetentionService) {}

  @Get()
  async get(@Req() request: SessionGatewayRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { tenantId, workspaceId } = scope(request);
    const setting = await this.run(request, () => this.retention.get(tenantId, workspaceId));
    reply.header("ETag", setting.etag);
    return toResponse(setting);
  }

  @Get("preview")
  async preview(@Req() request: SessionGatewayRequest, @Query("retention_days") retentionDays?: string) {
    const { tenantId, workspaceId } = scope(request);
    const days = wholeNumber(retentionDays, request.url);
    const runsToDelete = await this.run(request, () => this.retention.preview(tenantId, workspaceId, days));
    return { retention_days: days, runs_to_delete: runsToDelete };
  }

  @Put()
  async set(
    @Req() request: SessionGatewayRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers("if-match") ifMatch?: string,
  ) {
    const { tenantId, workspaceId, userId } = writer(request);
    if (ifMatch === undefined || ifMatch.trim().length === 0) {
      throw new HttpException(problem(request.url, 428, "RUN_RETENTION_IF_MATCH_REQUIRED", "If-Match with the setting's ETag is required"), 428);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw badRequest(request.url, "a JSON object body is required");
    const input = body as Record<string, unknown>;
    const extra = Object.keys(input).find((key) => key !== "retention_days" && key !== "confirm_lowering");
    if (extra !== undefined) throw badRequest(request.url, `unknown field ${extra}`);
    if (input.confirm_lowering !== undefined && typeof input.confirm_lowering !== "boolean") {
      throw badRequest(request.url, "confirm_lowering must be true or false");
    }
    if (typeof input.retention_days !== "number") throw badRequest(request.url, "retention_days must be a whole number");
    const retentionDays = input.retention_days;
    const setting = await this.run(request, () =>
      this.retention.set(
        tenantId,
        workspaceId,
        { retentionDays, confirmLowering: input.confirm_lowering === true, updatedBy: userId },
        ifMatch.trim(),
      ),
    );
    reply.header("ETag", setting.etag);
    return toResponse(setting);
  }

  private async run<T>(request: SessionGatewayRequest, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      if (error instanceof RunRetentionValidationError) throw badRequest(request.url, error.message);
      if (error instanceof RunRetentionStaleError) {
        throw new HttpException(problem(request.url, 412, "RUN_RETENTION_STALE", error.message), 412);
      }
      if (error instanceof RunRetentionConfirmationRequiredError) {
        throw new HttpException(
          { ...problem(request.url, 409, "RUN_RETENTION_CONFIRM_REQUIRED", error.message), runs_to_delete: error.runsToDelete },
          409,
        );
      }
      throw new HttpException(problem(request.url, 500, "RUN_RETENTION_INTERNAL", "Run-history retention could not be read or written"), 500);
    }
  }
}

function toResponse(setting: RunRetentionSetting) {
  return {
    retention_days: setting.retentionDays,
    is_default: setting.isDefault,
    updated_at: setting.updatedAt,
    updated_by: setting.updatedBy,
    etag: setting.etag,
  };
}

function scope(request: SessionGatewayRequest): { tenantId: string; workspaceId: string } {
  const actor = request.actorContext;
  if (actor === undefined || actor.workspace_id === null || actor.workspace_id === undefined) {
    throw new HttpException(problem(request.url, 500, "RUN_RETENTION_INTERNAL", "Missing authenticated workspace context"), 500);
  }
  return { tenantId: actor.tenant_id, workspaceId: actor.workspace_id };
}

/** Changing retention needs a person holding runs:retention:write; the platform checks the role, this checks the grant again. */
function writer(request: SessionGatewayRequest): { tenantId: string; workspaceId: string; userId: string } {
  const { tenantId, workspaceId } = scope(request);
  const actor = request.actorContext!;
  if (actor.actor_type !== "user" || actor.user_id === null || !actor.permissions.includes(RUN_RETENTION_WRITE)) {
    throw new HttpException(problem(request.url, 403, "RUN_RETENTION_WRITE_REQUIRED", "Changing run-history retention needs runs:retention:write"), 403);
  }
  return { tenantId, workspaceId, userId: actor.user_id };
}

function wholeNumber(value: string | undefined, instance: string | undefined): number {
  if (value === undefined || !/^\d{1,4}$/.test(value)) throw badRequest(instance, "retention_days must be a whole number");
  return Number(value);
}

function badRequest(instance: string | undefined, detail: string): HttpException {
  return new HttpException(problem(instance, 400, "RUN_RETENTION_VALIDATION_FAILED", detail), 400);
}

function problem(
  instance: string | undefined,
  status: 400 | 403 | 409 | 412 | 428 | 500,
  errorCode: string,
  detail: string,
): ProblemDetails {
  const titles = {
    400: "Bad Request",
    403: "Forbidden",
    409: "Conflict",
    412: "Precondition Failed",
    428: "Precondition Required",
    500: "Internal Server Error",
  } as const;
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: titles[status],
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "run-retention",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
