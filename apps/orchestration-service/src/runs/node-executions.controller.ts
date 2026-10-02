import { randomUUID } from "node:crypto";

import { Controller, Get, HttpException, Param, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import {
  ProblemDetailsSchema,
  type ProblemDetails,
} from "@alterx/contracts";
import {
  NodeExecutionLedgerService,
  NodeExecutionRunNotFoundError,
  NodeExecutionValidationError,
} from "./node-execution-ledger.service";

interface NodeExecutionsQuery {
  readonly cursor?: string;
  readonly limit?: string;
}

@Controller("api/v1/runs")
export class NodeExecutionsController {
  constructor(private readonly ledger: NodeExecutionLedgerService) {}

  @Get(":id/node-executions")
  async list(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("id") runId: string,
    @Query() query: NodeExecutionsQuery,
  ) {
    const tenantId = request.actorContext?.tenant_id;
    if (tenantId === undefined) {
      throw new HttpException(problem(request.url, 500, "Missing authenticated tenant context"), 500);
    }
    try {
      return await this.ledger.list(tenantId, runId, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
    } catch (error: unknown) {
      if (error instanceof NodeExecutionRunNotFoundError) {
        throw new HttpException(problem(request.url, 404, error.message), 404);
      }
      if (error instanceof NodeExecutionValidationError) {
        throw new HttpException(problem(request.url, 400, error.message), 400);
      }
      throw new HttpException(
        problem(request.url, 500, "Node executions could not be listed"),
        500,
      );
    }
  }
}

function problem(
  instance: string | undefined,
  status: 400 | 404 | 500,
  detail: string,
): ProblemDetails {
  const title = status === 400 ? "Bad Request" : status === 404 ? "Not Found" : "Internal Server Error";
  const errorCode =
    status === 400
      ? "NODE_EXECUTIONS_VALIDATION_FAILED"
      : status === 404
        ? "RUN_NOT_FOUND"
        : "NODE_EXECUTIONS_INTERNAL";
  return ProblemDetailsSchema.parse({
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: generatedId("trc"),
    request_id: generatedId("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "runs.node-executions",
  });
}

function generatedId(prefix: "trc" | "req"): string {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}`;
}
