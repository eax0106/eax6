import { randomUUID } from "node:crypto";
import { Controller, Delete, HttpCode, HttpException, Param, Put, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";

import { WorkspaceHoldsService, WorkspaceHoldValidationError } from "./workspace-holds.service";

const HOLD_ROLES = new Set(["owner", "admin"]);

/**
 * D2: the platform holds a workspace pending deletion and releases it on
 * restore. A person with a tenant owner or admin role only; the platform
 * checks the same before relaying.
 */
@Controller("api/v1/workspace-holds")
export class WorkspaceHoldsController {
  constructor(private readonly holds: WorkspaceHoldsService) {}

  @Put(":workspaceId")
  @HttpCode(204)
  async hold(@Req() request: SessionGatewayRequest, @Param("workspaceId") workspaceId: string): Promise<void> {
    const { tenantId, userId } = admin(request);
    await this.run(request, () => this.holds.hold(tenantId, workspaceId, userId));
  }

  @Delete(":workspaceId")
  @HttpCode(204)
  async release(@Req() request: SessionGatewayRequest, @Param("workspaceId") workspaceId: string): Promise<void> {
    const { tenantId } = admin(request);
    await this.run(request, () => this.holds.release(tenantId, workspaceId));
  }

  private async run(request: SessionGatewayRequest, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      if (error instanceof WorkspaceHoldValidationError) {
        throw new HttpException(problem(request.url, 400, "WORKSPACE_HOLD_VALIDATION_FAILED", error.message), 400);
      }
      throw new HttpException(problem(request.url, 500, "WORKSPACE_HOLD_INTERNAL", "Workspace hold could not be changed"), 500);
    }
  }
}

function admin(request: SessionGatewayRequest): { tenantId: string; userId: string } {
  const actor = request.actorContext;
  if (actor === undefined) {
    throw new HttpException(problem(request.url, 500, "WORKSPACE_HOLD_INTERNAL", "Missing authenticated tenant context"), 500);
  }
  if (actor.actor_type !== "user" || actor.user_id === null || !actor.roles.some((role) => HOLD_ROLES.has(role))) {
    throw new HttpException(problem(request.url, 403, "WORKSPACE_HOLD_FORBIDDEN", "Holding a workspace needs a tenant owner or admin"), 403);
  }
  return { tenantId: actor.tenant_id, userId: actor.user_id };
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
    documentation_key: "workspaces.holds",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
