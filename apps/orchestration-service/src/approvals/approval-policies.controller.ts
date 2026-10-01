import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpException, Param, Put, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";

import {
  ApprovalPolicyConfirmationRequiredError,
  ApprovalPolicyNotFoundError,
  ApprovalPolicyService,
  ApprovalPolicyValidationError,
  type ApprovalStepPolicy,
} from "./approval-policy.service";

const APPROVAL_RIGHTS = "approvals:decide";

/**
 * D5: the mode of each approval step of a workflow. Reading needs the
 * caller's workspace; changing a mode needs a person with approval rights.
 */
@Controller("api/v1/workflows/:workflowId/approval-policies")
export class ApprovalPoliciesController {
  constructor(private readonly policies: ApprovalPolicyService) {}

  @Get()
  async list(@Req() request: SessionGatewayRequest, @Param("workflowId") workflowId: string) {
    const { tenantId, workspaceId } = scope(request);
    const steps = await this.run(request, () => this.policies.list(tenantId, workspaceId, workflowId));
    return { data: steps.map(toResponse) };
  }

  @Put(":nodeKey")
  async set(
    @Req() request: SessionGatewayRequest,
    @Param("workflowId") workflowId: string,
    @Param("nodeKey") nodeKey: string,
    @Body() body: unknown,
  ) {
    const { tenantId, workspaceId } = scope(request);
    const actor = request.actorContext!;
    if (actor.actor_type !== "user" || actor.user_id === null || !actor.permissions.includes(APPROVAL_RIGHTS)) {
      throw new HttpException(problem(request.url, 403, "APPROVAL_POLICY_FORBIDDEN", "Setting an approval mode needs approval rights"), 403);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw badRequest(request.url, "a JSON object body is required");
    const input = body as Record<string, unknown>;
    const extra = Object.keys(input).find((key) => !["mode", "skip_on_timeout", "timeout_seconds", "confirm_consequence"].includes(key));
    if (extra !== undefined) throw badRequest(request.url, `unknown field ${extra}`);
    if (input.mode !== "ask" && input.mode !== "auto") throw badRequest(request.url, "mode must be ask or auto");
    if (input.skip_on_timeout !== undefined && typeof input.skip_on_timeout !== "boolean") throw badRequest(request.url, "skip_on_timeout must be true or false");
    if (input.timeout_seconds !== undefined && input.timeout_seconds !== null && typeof input.timeout_seconds !== "number") {
      throw badRequest(request.url, "timeout_seconds must be a number");
    }
    if (input.confirm_consequence !== undefined && typeof input.confirm_consequence !== "string") {
      throw badRequest(request.url, "confirm_consequence must be a string");
    }
    const mode = input.mode;
    const step = await this.run(request, () =>
      this.policies.set(tenantId, workspaceId, workflowId, nodeKey, {
        mode,
        skipOnTimeout: input.skip_on_timeout === true,
        timeoutSeconds: typeof input.timeout_seconds === "number" ? input.timeout_seconds : null,
        ...(typeof input.confirm_consequence === "string" ? { confirmConsequence: input.confirm_consequence } : {}),
        setBy: actor.user_id!,
      }),
    );
    return toResponse(step);
  }

  private async run<T>(request: SessionGatewayRequest, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      if (error instanceof ApprovalPolicyValidationError) throw badRequest(request.url, error.message);
      if (error instanceof ApprovalPolicyNotFoundError) {
        throw new HttpException(problem(request.url, 404, "APPROVAL_STEP_NOT_FOUND", error.message), 404);
      }
      if (error instanceof ApprovalPolicyConfirmationRequiredError) {
        throw new HttpException(
          { ...problem(request.url, 409, "APPROVAL_POLICY_CONFIRMATION_REQUIRED", error.message), consequence: error.consequence },
          409,
        );
      }
      throw new HttpException(problem(request.url, 500, "APPROVAL_POLICY_INTERNAL", "Approval modes could not be read or written"), 500);
    }
  }
}

function toResponse(step: ApprovalStepPolicy) {
  return {
    node_key: step.nodeKey,
    mode: step.mode,
    side_effect_consequence: step.sideEffectConsequence,
    auto_confirmed_by: step.autoConfirmedBy,
    auto_confirmed_at: step.autoConfirmedAt,
    skip_on_timeout: step.skipOnTimeout,
    timeout_seconds: step.timeoutSeconds,
    consecutive_approvals: step.consecutiveApprovals,
    promotion_suggested: step.promotionSuggested,
    set_by: step.setBy,
    updated_at: step.updatedAt,
  };
}

function scope(request: SessionGatewayRequest): { tenantId: string; workspaceId: string } {
  const actor = request.actorContext;
  if (actor === undefined || actor.workspace_id === null || actor.workspace_id === undefined) {
    throw new HttpException(problem(request.url, 500, "APPROVAL_POLICY_INTERNAL", "Missing authenticated workspace context"), 500);
  }
  return { tenantId: actor.tenant_id, workspaceId: actor.workspace_id };
}

function badRequest(instance: string | undefined, detail: string): HttpException {
  return new HttpException(problem(instance, 400, "APPROVAL_POLICY_VALIDATION_FAILED", detail), 400);
}

function problem(instance: string | undefined, status: 400 | 403 | 404 | 409 | 500, errorCode: string, detail: string): ProblemDetails {
  const titles = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" } as const;
  const id = randomUUID();
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: titles[status],
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: `trc_${id.slice(0, 14)}7${id.slice(15)}`,
    request_id: `req_${id.slice(0, 14)}7${id.slice(15)}`,
    retryable: status === 500,
    field_errors: [],
    documentation_key: "approval-policies",
  } as ProblemDetails;
}
