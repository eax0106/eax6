import { randomBytes } from "node:crypto";
import type { HostedFormSetup } from "@alterx/contracts";
import type { JsonValue } from "@alterx/shared-clients";
import {
  EngineClient,
  type EngineCallerContext,
  type EngineRequestBody,
  type EngineResponse,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { TriggerHttpError } from "./problem";
import type {
  CreateTriggerInput,
  CreateTriggerVersionInput,
  RegisterTriggerResult,
  SetTriggerStatusInput,
  Trigger,
  TriggerListResult,
  TriggerTestResult,
  TriggerVersion,
  TriggerWebhookSecretRotation,
} from "./types";
import {
  parseTraceparent,
  parseTriggerId,
  parseWorkflowIdQuery,
} from "./validation";

export class TriggerService {
  constructor(private readonly engine: EngineClient) {}

  publicForm(triggerId: string, actor: ActorContext, traceparent: string | undefined): Promise<EngineResponse<HostedFormSetup>> {
    const instance = `/api/v1/triggers/${triggerId}/public-form`, id = parseTriggerId(triggerId, instance);
    return this.engine.get(`/api/v1/triggers/${encodeURIComponent(id)}/public-form`, callerContext(actor, traceparent, instance));
  }

  setPublicFormStatus(triggerId: string, input: SetTriggerStatusInput, actor: ActorContext, traceparent: string | undefined,
    idempotencyKey: string, ifMatch: string): Promise<EngineResponse<Trigger>> {
    const instance = `/api/v1/triggers/${triggerId}/public-form/status`, id = parseTriggerId(triggerId, instance);
    return this.engine.patch(`/api/v1/triggers/${encodeURIComponent(id)}/public-form/status`, jsonBody(input), callerContext(actor, traceparent, instance), { idempotencyKey, ifMatch });
  }

  create(
    input: CreateTriggerInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<RegisterTriggerResult>> {
    const instance = "/api/v1/triggers";
    return this.engine.post(
      instance,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  list(
    workflowId: string | undefined,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<TriggerListResult>> {
    const instance = "/api/v1/triggers";
    const parsedWorkflowId = parseWorkflowIdQuery(workflowId, instance);
    const path: `/api/v1/${string}` = parsedWorkflowId
      ? `${instance}?workflowId=${encodeURIComponent(parsedWorkflowId)}`
      : instance;
    return this.engine.get(
      path,
      callerContext(actor, traceparent, instance),
    );
  }

  get(
    triggerId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<Trigger>> {
    const instance = `/api/v1/triggers/${triggerId}`;
    const id = parseTriggerId(triggerId, instance);
    return this.engine.get(
      `/api/v1/triggers/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  createVersion(
    triggerId: string,
    input: CreateTriggerVersionInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
    ifMatch?: string,
  ): Promise<EngineResponse<TriggerVersion>> {
    const instance = `/api/v1/triggers/${triggerId}/versions`;
    const id = parseTriggerId(triggerId, instance);
    return this.engine.post(
      `/api/v1/triggers/${encodeURIComponent(id)}/versions`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey, ...(ifMatch === undefined ? {} : { ifMatch }) },
    );
  }

  setStatus(
    triggerId: string,
    input: SetTriggerStatusInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
    ifMatch: string,
  ): Promise<EngineResponse<Trigger>> {
    const instance = `/api/v1/triggers/${triggerId}/status`;
    const id = parseTriggerId(triggerId, instance);
    return this.engine.patch(
      `/api/v1/triggers/${encodeURIComponent(id)}/status`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey, ifMatch },
    );
  }

  enable(
    triggerId: string,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<Trigger>> {
    return this.action(triggerId, "enable", actor, traceparent, idempotencyKey);
  }

  test(
    triggerId: string,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<TriggerTestResult>> {
    return this.action(triggerId, "test", actor, traceparent, idempotencyKey);
  }

  rotateWebhookSecret(
    triggerId: string,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<TriggerWebhookSecretRotation>> {
    return this.action(triggerId, "rotate-webhook-secret", actor, traceparent, idempotencyKey);
  }

  private action<T>(
    triggerId: string,
    action: "enable" | "test" | "rotate-webhook-secret",
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<T>> {
    const instance = `/api/v1/triggers/${triggerId}/actions/${action}`;
    const id = parseTriggerId(triggerId, instance);
    return this.engine.post(
      `/api/v1/triggers/${encodeURIComponent(id)}/actions/${action}`,
      {},
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }
}

function callerContext(
  actor: ActorContext,
  traceparent: string | undefined,
  instance: string,
): EngineCallerContext {
  if (!actor.workspace_id) {
    throw new TriggerHttpError(
      403,
      "TRIGGER_WORKSPACE_REQUIRED",
      "Workspace actor context required",
      instance,
    );
  }
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1_000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: parseTraceparent(traceparent, instance) ?? newTraceparent(),
  };
}

function jsonBody(value: unknown): EngineRequestBody {
  return value as JsonValue;
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
