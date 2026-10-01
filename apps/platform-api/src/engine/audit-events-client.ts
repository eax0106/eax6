import { Inject, Injectable } from "@nestjs/common";
import type {
  GetEventResponse,
  RecordEventRequest,
  RecordEventResponse,
} from "@alterx/contracts";
import type { SecretsProvider } from "@alterx/shared-clients";

import type { EngineConfig } from "./config";
import { ENGINE_CONFIG } from "./engine-client";
import { EngineProblemError, upstreamProblem } from "./problem";

const actorTypes = ["user", "service", "admin", "support", "system"] as const;
const results = ["success", "denied", "error"] as const;

export type AuditEvent = GetEventResponse;
export interface AuditEventsPage {
  readonly events: readonly AuditEvent[];
  readonly next_cursor: string | null;
}

export interface AuditEventsQuery {
  readonly tenantId?: string;
  readonly actorTypes?: readonly (typeof actorTypes)[number][];
  readonly action?: string;
  readonly result?: (typeof results)[number];
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Internal service-token client. The token is resolved only through the
 * injected SecretsProvider and is never part of a platform response. */
@Injectable()
export class AuditEventsClient {
  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    private readonly secrets: SecretsProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async query(input: AuditEventsQuery): Promise<AuditEventsPage> {
    const instance = "/api/v1/audit-events";
    const token = await this.serviceToken(instance);

    const query = new URLSearchParams();
    if (input.tenantId !== undefined) query.set("tenant_id", input.tenantId);
    if (input.actorTypes !== undefined && input.actorTypes.length > 0) {
      query.set("actor_types", input.actorTypes.join(","));
    }
    if (input.action !== undefined) query.set("action", input.action);
    if (input.result !== undefined) query.set("result", input.result);
    if (input.occurredAfter !== undefined) query.set("occurred_after", input.occurredAfter);
    if (input.occurredBefore !== undefined) query.set("occurred_before", input.occurredBefore);
    if (input.cursor !== undefined) query.set("cursor", input.cursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.auditServiceBaseUrl.replace(/\/+$/, "")}/internal/audit-events${query.size > 0 ? `?${query}` : ""}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json, application/problem+json",
          },
        },
      );
    } catch {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }
    if (!response.ok) {
      throw new EngineProblemError(
        upstreamProblem(response.status >= 500 ? response.status : 502, instance, "UPSTREAM_SERVICE_ERROR"),
      );
    }
    try {
      const body: unknown = await response.json();
      if (!isPage(body)) throw new Error("invalid audit events response");
      return body;
    } catch {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }
  }

  async record(input: RecordEventRequest): Promise<RecordEventResponse> {
    const instance = "/internal/audit-events";
    const token = await this.serviceToken(instance);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.auditServiceBaseUrl.replace(/\/+$/, "")}/internal/audit-events`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json, application/problem+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
    } catch {
      throw new EngineProblemError(
        upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"),
      );
    }
    if (!response.ok) {
      throw new EngineProblemError(
        upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"),
      );
    }
    try {
      const body: unknown = await response.json();
      if (!isRecordEventResponse(body)) throw new Error("invalid audit response");
      return body;
    } catch {
      throw new EngineProblemError(
        upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"),
      );
    }
  }

  /**
   * D2: asks audit-service to erase one workspace through its deletion
   * orchestrator. Resolves only when every store verified the erasure.
   */
  async executeWorkspaceErasure(tenantId: string, workspaceId: string): Promise<{ manifestId: string; completed: boolean }> {
    const instance = "/internal/deletion/workspace/execute";
    const token = await this.serviceToken(instance);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.auditServiceBaseUrl.replace(/\/+$/, "")}${instance}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, application/problem+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tenantId, workspaceId }),
      });
    } catch {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }
    if (!response.ok) {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }
    const body = (await response.json().catch(() => undefined)) as { manifestId?: unknown; completed?: unknown } | undefined;
    if (typeof body?.manifestId !== "string" || body.completed !== true) {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }
    return { manifestId: body.manifestId, completed: true };
  }

  private async serviceToken(instance: string): Promise<string> {
    try {
      const token = await this.secrets.getSecret(
        this.config.auditQueryServiceTokenRef,
      );
      if (!token.trim()) throw new Error("empty audit service token");
      return token;
    } catch {
      throw new EngineProblemError(
        upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"),
      );
    }
  }
}

function isRecordEventResponse(value: unknown): value is RecordEventResponse {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.entry_hash === "string" &&
    /^[0-9a-f]{64}$/i.test(value.entry_hash);
}

function isPage(value: unknown): value is AuditEventsPage {
  return isRecord(value) && Array.isArray(value.events) && value.events.every(isEvent) &&
    (value.next_cursor === null || typeof value.next_cursor === "string");
}

function isEvent(value: unknown): value is AuditEvent {
  return isRecord(value) &&
    typeof value.id === "string" &&
    isActorType(value.actor_type) &&
    typeof value.actor_ref === "string" &&
    typeof value.action === "string" &&
    typeof value.target_type === "string" &&
    typeof value.target_ref === "string" &&
    isResult(value.result) &&
    typeof value.reason_code === "string" &&
    typeof value.context_json === "string" &&
    typeof value.occurred_at === "string" &&
    typeof value.entry_hash === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isActorType(value: unknown): value is (typeof actorTypes)[number] {
  return typeof value === "string" && actorTypes.includes(value as (typeof actorTypes)[number]);
}

function isResult(value: unknown): value is (typeof results)[number] {
  return typeof value === "string" && results.includes(value as (typeof results)[number]);
}
