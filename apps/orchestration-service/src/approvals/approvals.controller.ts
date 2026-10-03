import { workspaceReadScope } from "../workspace-read-scope";
import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpException, Param, Post, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";

import {
  ApprovalNotFoundError,
  ApprovalStateConflictError,
  ApprovalValidationError,
  ApprovalsService,
  type ApprovalRow,
} from "./approvals.service";

interface DecideApprovalBody {
  readonly note?: string;
}

interface ApprovalsQuery {
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

/** Strips the usr_ prefix (approvals.decided_by is a native uuid column). */
function bareDecidedBy(request: IdentityTenantGatewayRequest): string | undefined {
  const userId = request.actorContext?.user_id;
  if (userId === null || userId === undefined) return undefined;
  return userId.startsWith("usr_") ? userId.slice("usr_".length) : userId;
}

function toApprovalResponse(row: ApprovalRow): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.run_id,
    node_execution_id: row.node_execution_id,
    requested_action: row.requested_action,
    status: row.status,
    // ENGINE-FIX-P5-1b: additive -- owning workspace for platform-api's
    // workspace-bound RBAC resolver.
    workspace_id: row.workspace_id ?? null,
    requested_at: row.requested_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    decision_note: row.decision_note,
    expiry_at: row.expiry_at,
  };
}

@Controller("api/v1/approvals")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  async list(@Req() request: IdentityTenantGatewayRequest, @Query() query: ApprovalsQuery) {
    const tenantId = requiredTenantId(request);
    const scope = workspaceReadScope(request);
    try {
      const page = await this.approvals.list(tenantId, {
        ...scope,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      return {
        data: page.data.map(toApprovalResponse),
        page: page.page,
      };
    } catch (error: unknown) {
      throw mapApprovalError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: IdentityTenantGatewayRequest, @Param("id") approvalId: string) {
    const tenantId = requiredTenantId(request);
    try {
      return toApprovalResponse(await this.approvals.getById(tenantId, approvalId));
    } catch (error: unknown) {
      throw mapApprovalError(error, request.url);
    }
  }

  @Post(":id/actions/approve")
  async approve(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") approvalId: string,
    @Body() body: DecideApprovalBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      const row = await this.approvals.decide(
        tenantId,
        approvalId,
        "approved",
        bareDecidedBy(request),
        body?.note,
      );
      return toApprovalResponse(row);
    } catch (error: unknown) {
      throw mapApprovalError(error, request.url);
    }
  }

  @Post(":id/actions/reject")
  async reject(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") approvalId: string,
    @Body() body: DecideApprovalBody,
  ) {
    const tenantId = requiredTenantId(request);
    try {
      const row = await this.approvals.decide(
        tenantId,
        approvalId,
        "rejected",
        bareDecidedBy(request),
        body?.note,
      );
      return toApprovalResponse(row);
    } catch (error: unknown) {
      throw mapApprovalError(error, request.url);
    }
  }
}

function mapApprovalError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof ApprovalValidationError) {
    return badRequest(requestUrl, error.message);
  }
  if (error instanceof ApprovalNotFoundError) {
    return notFound(requestUrl, error.message);
  }
  if (error instanceof ApprovalStateConflictError) {
    return conflict(requestUrl, error.message);
  }
  return new HttpException(internalProblem(requestUrl, "Approvals request could not be completed"), 500);
}

function badRequest(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 400, "APPROVALS_VALIDATION_FAILED", detail, "approvals.validation-failed"),
    400,
  );
}

function notFound(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 404, "APPROVAL_NOT_FOUND", detail, "approvals.not-found"),
    404,
  );
}

function conflict(requestUrl: string | undefined, detail: string): HttpException {
  return new HttpException(
    problem(requestUrl, 409, "APPROVAL_STATE_CONFLICT", detail, "approvals.state-conflict"),
    409,
  );
}

function internalProblem(requestUrl: string | undefined, detail: string): ProblemDetails {
  return problem(requestUrl, 500, "APPROVALS_INTERNAL_ERROR", detail, "approvals.internal-error");
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
