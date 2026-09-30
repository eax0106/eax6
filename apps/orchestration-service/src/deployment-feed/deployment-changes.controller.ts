import { randomUUID } from "node:crypto";
import { Controller, Get, HttpException, Query, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";

import { DeploymentChangesService, DeploymentChangesValidationError } from "./deployment-changes.service";

/**
 * Workflow versions that went live recently, across a tenant's workspaces
 * (D1): the platform's jobs tell each workflow's owners its live version
 * changed. It crosses workspaces, so it answers the system principal only.
 */
@Controller("api/v1/deployment-changes")
export class DeploymentChangesController {
  constructor(private readonly changes: DeploymentChangesService) {}

  @Get()
  async list(@Req() request: SessionGatewayRequest, @Query("changed_after") changedAfter?: string) {
    const actor = request.actorContext;
    if (actor === undefined) {
      throw new HttpException(problem(request.url, 500, "DEPLOYMENT_CHANGES_INTERNAL", "Missing authenticated tenant context"), 500);
    }
    if (actor.actor_type !== "system") {
      throw new HttpException(problem(request.url, 403, "DEPLOYMENT_CHANGES_SYSTEM_ONLY", "This feed is for the platform's background jobs"), 403);
    }
    if (changedAfter === undefined) {
      throw new HttpException(problem(request.url, 400, "DEPLOYMENT_CHANGES_VALIDATION_FAILED", "changed_after is required"), 400);
    }
    try {
      const rows = await this.changes.since(actor.tenant_id, changedAfter);
      return { data: rows.map((row) => ({ ...row, workspace_id: `ws_${row.workspace_id}` })) };
    } catch (error: unknown) {
      if (error instanceof DeploymentChangesValidationError) {
        throw new HttpException(problem(request.url, 400, "DEPLOYMENT_CHANGES_VALIDATION_FAILED", error.message), 400);
      }
      throw new HttpException(problem(request.url, 500, "DEPLOYMENT_CHANGES_INTERNAL", "Deployment changes could not be listed"), 500);
    }
  }
}

function problem(instance: string | undefined, status: 400 | 403 | 500, errorCode: string, detail: string): ProblemDetails {
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Internal Server Error",
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "deployments.changes",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
