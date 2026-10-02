import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpException, Param, Post, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";

import {
  EscalationNotFoundError,
  EscalationStateConflictError,
  EscalationValidationError,
  EscalationsService,
  type EscalationRow,
} from "./escalations.service";

interface ResolveEscalationBody {
  readonly note?: string;
}

interface EscalationsQuery {
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(internalProblem(request.url, "Missing authenticated tenant context"), 500);
  }
  return tenantId;
}

/** Strips the usr_ prefix (escalations.claimed_by/resolved_by are native uuid columns). */
function bareActorUserId(request: IdentityTenantGatewayRequest): string | undefined {
  const userId = request.actorContext?.user_id;
  if (userId === null || userId === undefined) return undefined;
  return userId.startsWith("usr_") ? userId.slice("usr_".length) : userId;
}

function toEscalationResponse(row: EscalationRow): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.run_id,
    node_execution_id: row.node_execution_id,
    recovery_action_id: row.recovery_action_id,
    reason: row.reason,
    status: row.status,
    // ENGINE-FIX-P5-1b: additive -- owning workspace for platform-api's
    // workspace-bound RBAC resolver.
    workspace_id: row.workspace_id ?? null,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    resolution_note: row.resolution_note,
    created_at: row.created_at,
  };
}

@Controller("api/v1/escalations")
export class EscalationsController {
  constructor(private readonly escalations: EscalationsService) {}

  @Get()
  async list(@Req() request: IdentityTenantGatewayRequest, @Query() query: EscalationsQuery) {
    const tenantId = requiredTenantId(request);
    try {
      const page = await this.escalations.list(tenantId, {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      return {
        data: page.data.map(toEscalationResponse),
        page: page.page,
      };
    } catch (error: unknown) {
      throw mapEscalationError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: IdentityTenantGatewayRequest, @Param("id") escalationId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return toEscalationResponse(await this.escalations.getById(tenantId, escalationId));
    } catch (error: unknown) {
      throw mapEscalationError(error, request.url);
    }
  }

  @Post(":id/actions/claim")
  async claim(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") escalationId: string,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      const row = await this.escalations.claim(tenantId, escalationId, bareActorUserId(request));
      return toEscalationResponse(row);
    } catch (error: unknown) {
      throw mapEscalationError(error, request.url);
    }
  }

  @Post(":id/actions/resolve")
  async resolve(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") escalationId: string,
    @Body() body: ResolveEscalationBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      const row = await this.escalations.resolve(
        tenantId,
        escalationId,
        bareActorUserId(request),
        body?.note,
      );
      return toEscalationResponse(row);
    } catch (error: unknown) {
      throw mapEscalationError(error, request.url);
    }
  }
}

function mapEscalationError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof EscalationValidationError) {
    return badRequest(requestUrl, error.message);
  }
  if (error instanceof EscalationNotFoundError) {
    return notFound(requestUrl, error.message);
  }
  if (error instanceof EscalationStateConflictError) {
    return conflict(requestUrl, error.message);
  }
  return new HttpException(internalProblem(requestUrl, "Escalations request could not be completed"), 500);
}

function badRequest(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 400, "ESCALATIONS_VALIDATION_FAILED", detail, "escalations.validation-failed"),
    400,
  );
}

function notFound(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 404, "ESCALATION_NOT_FOUND", detail, "escalations.not-found"),
    404,
  );
}

function conflict(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 409, "ESCALATION_STATE_CONFLICT", detail, "escalations.state-conflict"),
    409,
  );
}

function internalProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return problem(requestUrl, 500, "ESCALATIONS_INTERNAL_ERROR", detail, "escalations.internal-error");
}

function problem(
  requestUrl: string | undefined,
  status: number,
  errorCode: string,
  detail: string,
  documentationKey: string,
): ProblemDetails {
  const title =
    status === 400 ? "Bad Request"
    : status === 404 ? "Not Found"
    : status === 409 ? "Conflict"
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
    retryable: false,
    field_errors: [],
    documentation_key: documentationKey,
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}` as `${typeof prefix}_${string}`;
}
