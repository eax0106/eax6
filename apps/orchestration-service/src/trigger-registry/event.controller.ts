import { randomUUID } from "node:crypto";
import { Body, Controller, Get, Headers, HttpException, Param, Post, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import { EventReplayService, ReplayConfirmationError, type ReplayActor } from "./event-replay.service";
import { RunStartFailedError, RunStateConflictError, RunValidationError, WorkflowNotFoundError } from "../runs/run-launcher.service";
import { mapRunError } from "../runs/runs.controller";
import { BudgetExceededError } from "../budgets/budget.service";
import { BlackboardValidationError } from "../blackboard/blackboard.service";
import {
  EventNotFoundError,
  EventQueryService,
  EventValidationError,
  type EventListQuery,
} from "./event-query.service";

interface EventListQueryParams {
  readonly source?: string;
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

@Controller("api/v1/events")
export class EventController {
  constructor(private readonly events: EventQueryService, private readonly replay: EventReplayService) {}

  @Post(":id/replay")
  async preview(@Req() request: IdentityTenantGatewayRequest, @Param("id") eventId: string) {
    const actor = replayActor(request, false);
    try { return await this.replay.preview(actor, eventId); }
    catch (error: unknown) { throw mapEventError(error, request.url); }
  }

  @Post(":id/replay-for-real")
  async replayForReal(@Req() request: IdentityTenantGatewayRequest, @Param("id") eventId: string,
    @Body() body: unknown, @Headers("idempotency-key") key: string | undefined) {
    const actor = replayActor(request, true);
    try { return await this.replay.replay(actor, eventId, body, key); }
    catch (error: unknown) { throw mapEventError(error, request.url); }
  }

  @Get()
  async list(@Req() request: IdentityTenantGatewayRequest, @Query() query: EventListQueryParams) {
    const tenantId = requireTenant(request);
    const listQuery: EventListQuery = {
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    };
    try {
      return await this.events.list(tenantId, listQuery);
    } catch (error: unknown) {
      throw mapEventError(error, request.url);
    }
  }

  @Get(":id")
  async get(@Req() request: IdentityTenantGatewayRequest, @Param("id") eventId: string) {
    const tenantId = requireTenant(request);
    try {
      return await this.events.get(tenantId, eventId);
    } catch (error: unknown) {
      throw mapEventError(error, request.url);
    }
  }
}

function replayActor(request: IdentityTenantGatewayRequest, real: boolean): ReplayActor {
  const actor = request.actorContext;
  if (!actor || actor.actor_type !== "user" || !actor.user_id || !actor.workspace_id) throw new HttpException(problem(request.url, 403, "User and workspace context required"), 403);
  const allowed = real ? actor.roles.some(role => ["admin", "editor", "operator"].includes(role)) && actor.permissions.includes("workflows:write")
    : actor.permissions.includes("runs:read");
  if (!allowed) throw new HttpException(problem(request.url, 403, "Replay permission required"), 403);
  return { tenantId: actor.tenant_id, workspaceId: actor.workspace_id, userId: actor.user_id };
}

function requireTenant(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(problem(request.url, 500, "Missing authenticated tenant context"), 500);
  }
  return tenantId;
}

function mapEventError(error: unknown, url: string | undefined): HttpException {
  if (error instanceof RunValidationError || error instanceof RunStateConflictError || error instanceof RunStartFailedError ||
      error instanceof WorkflowNotFoundError || error instanceof BudgetExceededError) return mapRunError(error, url);
  if (error instanceof EventValidationError || error instanceof BlackboardValidationError) {
    return new HttpException(problem(url, 400, error.message), 400);
  }
  if (error instanceof EventNotFoundError) {
    return new HttpException(problem(url, 404, error.message), 404);
  }
  if (error instanceof ReplayConfirmationError) {
    return new HttpException(problem(url, 409, error.message), 409);
  }
  return new HttpException(problem(url, 500, "Events could not be listed"), 500);
}

function problem(instance: string | undefined, status: 400 | 403 | 404 | 409 | 500, detail: string): ProblemDetails {
  const errorCode = status === 400 ? "EVENT_VALIDATION_FAILED" : status === 403 ? "EVENT_PERMISSION_REQUIRED" : status === 404 ? "EVENT_NOT_FOUND"
    : status === 409 ? "EVENT_REPLAY_CONFIRMATION_REQUIRED" : "EVENT_INTERNAL";
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Internal Server Error",
    status, detail, instance: instance?.startsWith("/") ? instance : "/", error_code: errorCode,
    trace_id: prefixedUuidV7("trc"), request_id: prefixedUuidV7("req"), retryable: status === 500,
    field_errors: [], documentation_key: "events",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
