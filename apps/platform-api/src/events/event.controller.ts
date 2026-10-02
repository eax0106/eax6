import {
  Controller,
  Body,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { EngineResponse } from "../engine";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { EventExceptionFilter } from "./event-exception.filter";
import { EventHttpError } from "./problem";
import { EventService } from "./event.service";
import type { EnginePage, EngineResource } from "./types";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;

// Reuses runs:read rather than minting a new permission string: events are
// the same "workflow execution observability" domain as runs (an event
// either dispatches a run or doesn't), and ROLE_PERMISSIONS
// (../rbac/permissions.ts) grants exactly this permission to exactly the
// roles that should be able to read this. Introducing "events:read" would
// need that table updated too, for the same set of roles, with no real
// difference in who's allowed to see what.
@Controller("/api/v1/events")
@UseFilters(EventExceptionFilter)
export class EventController {
  constructor(private readonly events: EventService) {}

  @Post(":eventId/replay")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async preview(@Param("eventId") eventId: string, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Res({ passthrough: true }) reply: FastifyReply): Promise<EngineResource> {
    return project(await this.events.preview(eventId, requireActor(actor, `/api/v1/events/${eventId}/replay`), traceparent), reply);
  }

  @Post(":eventId/replay-for-real")
  @RequireWorkspaceRole("admin", "editor", "operator")
  @RequirePermission("workflows:write")
  @Idempotent()
  async replay(@Param("eventId") eventId: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply): Promise<EngineResource> {
    return project(await this.events.replay(eventId, body, requireActor(actor, `/api/v1/events/${eventId}/replay-for-real`), traceparent, key), reply);
  }

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async list(
    @Query() query: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EnginePage<EngineResource>> {
    return project(
      await this.events.list(query, requireActor(actor, "/api/v1/events"), traceparent),
      reply,
    );
  }

  @Get(":eventId")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async get(
    @Param("eventId") eventId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EngineResource> {
    const instance = `/api/v1/events/${eventId}`;
    return project(
      await this.events.get(eventId, requireActor(actor, instance), traceparent),
      reply,
    );
  }
}

function requireActor(actor: ActorContextType | undefined, instance: string): ActorContextType {
  if (!actor) {
    throw new EventHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
  }
  return actor;
}

function project<T>(response: EngineResponse<T>, reply: FastifyReply): T {
  reply.status(response.status);
  if (response.location) reply.header("Location", response.location);
  if (response.requestId) reply.header("request_id", response.requestId);
  if (response.traceId) reply.header("trace_id", response.traceId);
  return response.body;
}
