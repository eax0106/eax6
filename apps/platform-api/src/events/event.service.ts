import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { EngineClient, type EngineCallerContext, type EngineResponse } from "../engine";
import type { ActorContext } from "../rbac/types";
import { EventHttpError } from "./problem";
import type { EnginePage, EngineResource } from "./types";
import { parseEventId, parseEventListQuery, parseTraceparent, serializeQuery } from "./validation";

@Injectable()
export class EventService {
  constructor(private readonly engine: EngineClient) {}

  preview(eventId: string, actor: ActorContext, traceparent: string | undefined): Promise<EngineResponse<EngineResource>> {
    const instance = `/api/v1/events/${eventId}/replay`;
    const id = parseEventId(eventId, instance);
    return this.engine.post(`/api/v1/events/${encodeURIComponent(id)}/replay`, {}, callerContext(actor, traceparent, instance), { idempotencyKey: `event-preview-${randomBytes(16).toString("hex")}` });
  }

  replay(eventId: string, body: unknown, actor: ActorContext, traceparent: string | undefined, key: string | undefined): Promise<EngineResponse<EngineResource>> {
    const instance = `/api/v1/events/${eventId}/replay-for-real`;
    const id = parseEventId(eventId, instance);
    const input = body as Record<string, unknown> | null;
    if (!input || Array.isArray(input) || input["confirmed"] !== true || typeof input["confirmationToken"] !== "string" ||
        !/^[0-9a-f]{64}$/.test(input["confirmationToken"]) || Object.keys(input).some(name => !["confirmed", "confirmationToken"].includes(name))) {
      throw new EventHttpError(400, "INVALID_EVENT_REQUEST", "Confirm the previewed outside actions before real replay", instance);
    }
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new EventHttpError(400, "INVALID_EVENT_REQUEST", "A valid Idempotency-Key is required", instance);
    return this.engine.post(`/api/v1/events/${encodeURIComponent(id)}/replay-for-real`,
      { confirmed: true, confirmationToken: input["confirmationToken"] }, callerContext(actor, traceparent, instance), { idempotencyKey: key });
  }

  list(
    input: unknown,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<EnginePage<EngineResource>>> {
    const instance = "/api/v1/events";
    const query = parseEventListQuery(input, instance);
    return this.engine.get(
      `/api/v1/events${serializeQuery(query)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  get(
    eventId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<EngineResource>> {
    const instance = `/api/v1/events/${eventId}`;
    const id = parseEventId(eventId, instance);
    return this.engine.get(
      `/api/v1/events/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
    );
  }
}

function callerContext(
  actor: ActorContext,
  traceparent: string | undefined,
  instance: string,
): EngineCallerContext {
  if (!actor.workspace_id) {
    throw new EventHttpError(403, "EVENT_WORKSPACE_REQUIRED", "Workspace context required", instance);
  }
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: parseTraceparent(traceparent, instance) ?? newTraceparent(),
  };
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
