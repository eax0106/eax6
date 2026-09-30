import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { EngineClient, type EngineCallerContext, type EngineRequestBody } from "../engine";
import type { ActorContext } from "../rbac/types";
import { BudgetHttpError } from "./problem";
import type { BudgetView, CreateBudgetInput, UpdateBudgetInput } from "./types";

/**
 * Budgets (D3): the engine owns them so Run Manager can check and reserve
 * atomically at run start. This relays the web's budget routes to the engine
 * through the caller's identity; the engine scopes every read and write to the
 * caller's workspace.
 */
@Injectable()
export class BudgetService {
  constructor(private readonly engine: EngineClient) {}

  async list(actor: ActorContext, traceparent: string | undefined): Promise<BudgetView[]> {
    const instance = "/api/v1/budgets";
    const response = await this.engine.get<{ data: BudgetView[] }>("/api/v1/budgets", callerContext(actor, traceparent, instance));
    return response.body.data;
  }

  async create(actor: ActorContext, input: CreateBudgetInput, idempotencyKey: string, traceparent: string | undefined): Promise<BudgetView> {
    const instance = "/api/v1/budgets";
    const response = await this.engine.post<EngineRequestBody, BudgetView>(
      "/api/v1/budgets",
      input as unknown as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
    return response.body;
  }

  async update(
    actor: ActorContext,
    id: string,
    input: UpdateBudgetInput,
    ifMatch: string,
    idempotencyKey: string,
    traceparent: string | undefined,
  ): Promise<BudgetView> {
    const instance = `/api/v1/budgets/${id}`;
    const response = await this.engine.patch<EngineRequestBody, BudgetView>(
      `/api/v1/budgets/${encodeURIComponent(id)}`,
      input as unknown as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey, ifMatch },
    );
    return response.body;
  }

  async remove(actor: ActorContext, id: string, idempotencyKey: string, traceparent: string | undefined): Promise<void> {
    const instance = `/api/v1/budgets/${id}`;
    await this.engine.delete(`/api/v1/budgets/${encodeURIComponent(id)}`, callerContext(actor, traceparent, instance), { idempotencyKey });
  }
}

function callerContext(actor: ActorContext, traceparent: string | undefined, instance: string): EngineCallerContext {
  if (!actor.workspace_id) throw new BudgetHttpError(403, "BUDGET_WORKSPACE_REQUIRED", "Workspace actor context required", instance);
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: validTraceparent(traceparent) ? traceparent : newTraceparent(),
  };
}

function validTraceparent(value: string | undefined): value is string {
  return typeof value === "string" && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[01]$/i.test(value);
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
