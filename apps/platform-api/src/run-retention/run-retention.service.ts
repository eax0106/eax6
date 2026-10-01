import { randomBytes, randomUUID } from "node:crypto";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { EngineClient, type EngineCallerContext, type EngineRequestBody } from "../engine";
import type { ActorContext } from "../rbac/types";
import { PlatformHttpError } from "../signup/problem";

export interface RunRetentionView {
  retention_days: number;
  is_default: boolean;
  updated_at: string | null;
  updated_by: string | null;
  etag: string;
}

const BASE = "/api/v1/run-retention";

/**
 * D2 run-history retention. The engine owns the setting because its daily
 * sweep applies it; this relays the web's routes through the caller's
 * identity and audits every change.
 */
export class RunRetentionRelayService {
  constructor(
    private readonly engine: EngineClient,
    private readonly audit: AuditEventHandler,
  ) {}

  async get(actor: ActorContext, traceparent: string | undefined): Promise<RunRetentionView> {
    return (await this.engine.get<RunRetentionView>(BASE, callerContext(actor, traceparent))).body;
  }

  async preview(
    actor: ActorContext,
    retentionDays: string | undefined,
    traceparent: string | undefined,
  ): Promise<{ retention_days: number; runs_to_delete: number }> {
    if (retentionDays === undefined || !/^\d{1,3}$/.test(retentionDays)) {
      throw new PlatformHttpError(400, "RUN_RETENTION_VALIDATION_FAILED", "retention_days must be a whole number", `${BASE}/preview`);
    }
    const response = await this.engine.get<{ retention_days: number; runs_to_delete: number }>(
      `${BASE}/preview?retention_days=${retentionDays}`,
      callerContext(actor, traceparent),
    );
    return response.body;
  }

  async set(
    actor: ActorContext,
    body: unknown,
    ifMatch: string | undefined,
    traceparent: string | undefined,
  ): Promise<RunRetentionView> {
    if (ifMatch === undefined || ifMatch.trim().length === 0) {
      throw new PlatformHttpError(428, "RUN_RETENTION_IF_MATCH_REQUIRED", "If-Match with the setting's ETag is required", BASE);
    }
    const before = await this.get(actor, traceparent);
    const response = await this.engine.put<EngineRequestBody, RunRetentionView>(
      BASE,
      body as EngineRequestBody,
      callerContext(actor, traceparent),
      { idempotencyKey: `run-retention-${randomUUID()}`, ifMatch: ifMatch.trim() },
    );
    const after = response.body;
    await this.audit.recordEvent({
      tenant_id: actor.tenant_id,
      actor_type: "user",
      actor_ref: actor.user_id,
      action: "workspace.run_retention.update",
      target_type: "workspace",
      target_ref: actor.workspace_id!,
      result: "success",
      reason_code: "",
      context_json: JSON.stringify({ before_days: before.retention_days, after_days: after.retention_days }),
      occurred_at: new Date().toISOString(),
    });
    return after;
  }
}

function callerContext(actor: ActorContext, traceparent: string | undefined): EngineCallerContext {
  if (!actor.workspace_id) {
    throw new PlatformHttpError(403, "RUN_RETENTION_WORKSPACE_REQUIRED", "Workspace actor context required", BASE);
  }
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent:
      typeof traceparent === "string" && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[01]$/i.test(traceparent)
        ? traceparent
        : `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
  };
}
