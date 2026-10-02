import { Body, Controller, Get, HttpException, Param, Post, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import { randomUUID } from "node:crypto";
import {
  ClarificationNotFoundError,
  ClarificationStateConflictError,
  ClarificationsService,
  ClarificationValidationError,
  type ClarificationRow,
} from "./clarifications.service";

interface ClarificationsQuery {
  readonly cursor?: string;
  readonly limit?: string;
}

interface AssignClarificationBody {
  readonly assignee_user_id?: string | null;
}

function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(problem(request.url, 500, "CLARIFICATIONS_INTERNAL_ERROR", "Missing authenticated tenant context"), 500);
  }
  return tenantId;
}

function response(row: ClarificationRow): Record<string, unknown> {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    question: row.question,
    status: row.status,
    assignee_user_id: row.assignee_user_id === null ? null : `usr_${row.assignee_user_id}`,
    assigned_at: row.assigned_at,
    requested_at: row.requested_at,
    answered_at: row.answered_at,
    expiry_at: row.expiry_at,
    // ENGINE-FIX-P5-1b: additive -- owning workspace for platform-api's
    // workspace-bound RBAC resolver.
    workspace_id: row.workspace_id ?? null,
    run_id: row.run_id ?? null,
    node_execution_id: row.node_execution_id ?? null,
    description: row.question,
    answer: row.answer ?? null,
  };
}

@Controller("api/v1/clarifications")
export class ClarificationsController {
  constructor(private readonly clarifications: ClarificationsService) {}

  @Get()
  async list(@Req() request: IdentityTenantGatewayRequest, @Query() query: ClarificationsQuery) {
    try {
      const page = await this.clarifications.list(requiredTenantId(request), {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      return { data: page.data.map(response), page: page.page };
    } catch (error: unknown) {
      throw mapError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: IdentityTenantGatewayRequest, @Param("id") clarificationId: string) {
    try {
      return response(
        await this.clarifications.getById(requiredTenantId(request), clarificationId),
      );
    } catch (error: unknown) {
      throw mapError(error, request.url);
    }
  }

  @Post(":id/actions/assign")
  async assign(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") clarificationId: string,
    @Body() body: AssignClarificationBody,
  ) {
    try {
      if (body?.assignee_user_id === undefined) {
        throw new ClarificationValidationError("assignee_user_id is required; use null to unassign");
      }
      return response(
        await this.clarifications.assign(
          requiredTenantId(request),
          clarificationId,
          body.assignee_user_id,
        ),
      );
    } catch (error: unknown) {
      throw mapError(error, request.url);
    }
  }
}

@Controller("api/v1/runs")
export class RecoveryClarificationController {
  constructor(private readonly clarifications: ClarificationsService) {}

  @Post(":runId/clarifications/:clarificationId/answer")
  async answer(@Req() request: IdentityTenantGatewayRequest, @Param("runId") runId: string,
    @Param("clarificationId") clarificationId: string, @Body() body: { readonly note?: unknown }) {
    try {
      return response(await this.clarifications.answerRecovery(requiredTenantId(request), runId, clarificationId, body?.note));
    } catch (error: unknown) {
      throw mapError(error, request.url);
    }
  }
}

function mapError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof ClarificationValidationError) {
    return new HttpException(problem(requestUrl, 400, "CLARIFICATIONS_VALIDATION_FAILED", error.message), 400);
  }
  if (error instanceof ClarificationNotFoundError) {
    return new HttpException(problem(requestUrl, 404, "CLARIFICATION_NOT_FOUND", error.message), 404);
  }
  if (error instanceof ClarificationStateConflictError) {
    return new HttpException(problem(requestUrl, 409, "CLARIFICATION_STATE_CONFLICT", error.message), 409);
  }
  return new HttpException(problem(requestUrl, 500, "CLARIFICATIONS_INTERNAL_ERROR", "Clarifications request could not be completed"), 500);
}

function problem(
  requestUrl: string | undefined,
  status: number,
  errorCode: string,
  detail: string,
): ProblemDetails {
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Internal Server Error",
    status,
    detail,
    instance: requestUrl?.startsWith("/") ? requestUrl : "/",
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
