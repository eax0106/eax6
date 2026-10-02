import { randomUUID } from "node:crypto";
import { Controller, Get, HttpException, Param, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import {
  RunObservabilityRunNotFoundError,
  RunObservabilityService,
  RunObservabilityValidationError,
} from "./run-observability.service";

interface PageQuery { readonly cursor?: string; readonly limit?: string; }

@Controller("api/v1/runs")
export class RunObservabilityController {
  constructor(private readonly observability: RunObservabilityService) {}

  @Get(":id/verification-results")
  verification(@Req() request: IdentityTenantGatewayRequest, @Param("id") runId: string, @Query() query: PageQuery) {
    return this.run(request, runId, query, (tenantId, page) => this.observability.verificationResults(tenantId, runId, page));
  }

  @Get(":id/recovery-actions")
  recovery(@Req() request: IdentityTenantGatewayRequest, @Param("id") runId: string, @Query() query: PageQuery) {
    return this.run(request, runId, query, (tenantId, page) => this.observability.recoveryActions(tenantId, runId, page));
  }

  @Get(":id/quality-gates")
  qualityGates(@Req() request: IdentityTenantGatewayRequest, @Param("id") runId: string, @Query() query: PageQuery) {
    return this.run(request, runId, query, (tenantId, page) => this.observability.qualityGates(tenantId, runId, page));
  }

  private async run(
    request: IdentityTenantGatewayRequest,
    runId: string,
    query: PageQuery,
    operation: (tenantId: string, page: { cursor?: string; limit?: number }) => Promise<unknown>,
  ) {
    const tenantId = request.actorContext?.tenant_id;
    if (tenantId === undefined) throw new HttpException(problem(request.url, 500, "Missing authenticated tenant context"), 500);
    try {
      return await operation(tenantId, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
    } catch (error: unknown) {
      if (error instanceof RunObservabilityRunNotFoundError) {
        throw new HttpException(problem(request.url, 404, error.message), 404);
      }
      if (error instanceof RunObservabilityValidationError) {
        throw new HttpException(problem(request.url, 400, error.message), 400);
      }
      throw new HttpException(problem(request.url, 500, "Run observability could not be listed"), 500);
    }
  }
}

function problem(instance: string | undefined, status: 400 | 404 | 500, detail: string): ProblemDetails {
  const errorCode = status === 400 ? "RUN_OBSERVABILITY_VALIDATION_FAILED" : status === 404 ? "RUN_NOT_FOUND" : "RUN_OBSERVABILITY_INTERNAL";
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 404 ? "Not Found" : "Internal Server Error",
    status, detail, instance: instance?.startsWith("/") ? instance : "/", error_code: errorCode,
    trace_id: prefixedUuidV7("trc"), request_id: prefixedUuidV7("req"), retryable: status === 500,
    field_errors: [], documentation_key: "runs.observability",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
