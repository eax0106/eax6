import { randomUUID } from "node:crypto";

import { Controller, Get, HttpException, Inject, Logger, Param, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import type { AuditEventHandler } from "@alterx/shared-clients";
import {
  RunOutcomeNotCompletedError,
  RunOutcomeRunNotFoundError,
  RunOutcomeService,
  RunOutcomeTenantMismatchError,
  RunOutcomeValidationError,
} from "./run-outcome.service";

/** Where a service-asserted tenant is recorded (design log §30, requirement 3). */
export const RUN_LEARNING_AUDIT = Symbol("RUN_LEARNING_AUDIT");

@Controller("internal/runs")
export class RunLearningController {
  private readonly logger = new Logger(RunLearningController.name);

  constructor(
    private readonly outcomes: RunOutcomeService,
    @Inject(RUN_LEARNING_AUDIT) private readonly audit: AuditEventHandler,
  ) {}

  /**
   * `tenant_id` is honoured only for a service caller, and ignored entirely
   * for a user one.
   *
   * memory-service calls this under its own machine identity rather than
   * forwarding its caller's credential, so the tenant in its token is
   * memory-service's own and not the run's -- without an explicit parameter
   * it could only ever read runs belonging to its service identity. This is
   * the "pass tenant as an explicit parameter" half of that decision, which
   * intelligence-service's performance endpoint already does for the same
   * reason.
   *
   * The actor_type check is what stops this widening anything: the route sits
   * behind SessionGatewayGuard, which authenticates user session tokens as
   * readily as service ones, and a user naming an arbitrary tenant here would
   * be a cross-tenant read.
   */
  @Get(":id/outcome-summary")
  async summary(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") runId: string,
    @Query("tenant_id") requestedTenantId?: string,
  ) {
    const actor = request.actorContext;
    if (actor === undefined) {
      throw new HttpException(
        problem(request.url, 500, "RUN_LEARNING_INTERNAL", "Missing authenticated tenant context"),
        500,
      );
    }
    const asserted = actor.actor_type === "service" && requestedTenantId !== undefined;
    const tenantId =
      asserted && requestedTenantId !== undefined ? requestedTenantId : actor.tenant_id;
    try {
      const summary = await this.outcomes.getLearningSummary(tenantId, runId, {
        assertedByService: asserted,
      });
      if (asserted) await this.#auditAssertion(actor.tenant_id, tenantId, runId, "success");
      return summary;
    } catch (error: unknown) {
      if (asserted) {
        await this.#auditAssertion(
          actor.tenant_id,
          tenantId,
          runId,
          error instanceof RunOutcomeTenantMismatchError ? "denied" : "error",
        );
      }
      if (error instanceof RunOutcomeTenantMismatchError) {
        throw new HttpException(
          problem(request.url, 403, "SERVICE_TENANT_MISMATCH", error.message),
          403,
        );
      }
      if (error instanceof RunOutcomeValidationError) {
        throw new HttpException(
          problem(request.url, 400, "RUN_LEARNING_VALIDATION_FAILED", error.message),
          400,
        );
      }
      if (error instanceof RunOutcomeRunNotFoundError) {
        throw new HttpException(
          problem(request.url, 404, "RUN_NOT_FOUND", error.message),
          404,
        );
      }
      if (error instanceof RunOutcomeNotCompletedError) {
        throw new HttpException(
          problem(request.url, 409, "RUN_NOT_COMPLETED", error.message),
          409,
        );
      }
      throw new HttpException(
        problem(request.url, 500, "RUN_LEARNING_INTERNAL", "Run summary could not be loaded"),
        500,
      );
    }
  }

  /**
   * Every service-asserted tenant is audited (design log §30): the shared
   * service credential is the weak point, and this trail is what makes a
   * leak recoverable. Audit writes fail open with a loud log (planes 38) --
   * they never block the read they describe.
   */
  async #auditAssertion(
    callerTenant: string,
    assertedTenant: string,
    runId: string,
    result: "success" | "denied" | "error",
  ): Promise<void> {
    try {
      await this.audit.recordEvent({
        tenant_id: assertedTenant,
        actor_type: "service",
        actor_ref: `service:${callerTenant}`,
        action: "run.outcome_summary.read",
        target_type: "run",
        target_ref: runId,
        result,
        reason_code: "",
        context_json: JSON.stringify({ scope: "tenant_asserted_by_service" }),
        occurred_at: new Date().toISOString(),
      });
    } catch (error: unknown) {
      this.logger.error({
        message: "service-asserted tenant audit write failed",
        runId,
        assertedTenant,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function problem(
  instance: string | undefined,
  status: 400 | 403 | 404 | 409 | 500,
  errorCode: string,
  detail: string,
): ProblemDetails {
  const id = randomUUID();
  const requestId = randomUUID();
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title:
      status === 400 ? "Bad Request"
      : status === 403 ? "Forbidden"
      : status === 404 ? "Not Found"
      : status === 409 ? "Conflict"
      : "Internal Server Error",
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: `trc_${id.slice(0, 14)}7${id.slice(15)}`,
    request_id: `req_${requestId.slice(0, 14)}7${requestId.slice(15)}`,
    retryable: status === 500,
    field_errors: [],
    documentation_key: "memory.run-outcome-summary",
  };
}
