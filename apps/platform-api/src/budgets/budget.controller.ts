import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { BudgetService } from "./budget.service";
import { BudgetHttpError } from "./problem";
import type { BudgetView } from "./types";
import { parseBudgetId, parseCreateBudget, parseUpdateBudget } from "./validation";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const BASE = "/api/v1/budgets";

@Controller(BASE)
export class BudgetController {
  constructor(private readonly budgets: BudgetService) {}

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("billing:read")
  list(
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<BudgetView[]> {
    return this.budgets.list(requireActor(actor, BASE), traceparent);
  }

  @Post()
  @HttpCode(201)
  @RequireWorkspaceRole("admin")
  @RequirePermission("budgets:write")
  @Idempotent()
  create(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<BudgetView> {
    return this.budgets.create(requireActor(actor, BASE), parseCreateBudget(body, BASE), idempotencyKey!, traceparent);
  }

  @Patch(":budgetId")
  @RequireWorkspaceRole("admin")
  @RequirePermission("budgets:write")
  update(
    @Param("budgetId") budgetId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<BudgetView> {
    const instance = `${BASE}/${budgetId}`;
    const id = parseBudgetId(budgetId, instance);
    const input = parseUpdateBudget(body, instance);
    if (ifMatch === undefined || ifMatch.trim().length === 0) {
      throw new BudgetHttpError(428, "BUDGET_IF_MATCH_REQUIRED", "If-Match with the budget's updated_at is required", instance);
    }
    return this.budgets.update(requireActor(actor, instance), id, input, ifMatch.trim(), `budget-update-${randomUUID()}`, traceparent);
  }

  @Delete(":budgetId")
  @HttpCode(204)
  @RequireWorkspaceRole("admin")
  @RequirePermission("budgets:write")
  remove(
    @Param("budgetId") budgetId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<void> {
    const instance = `${BASE}/${budgetId}`;
    return this.budgets.remove(requireActor(actor, instance), parseBudgetId(budgetId, instance), `budget-delete-${randomUUID()}`, traceparent);
  }
}

function requireActor(actor: ActorContextType | undefined, instance: string): ActorContextType {
  if (!actor) throw new BudgetHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
  if (!actor.workspace_id) throw new BudgetHttpError(403, "BUDGET_WORKSPACE_REQUIRED", "Workspace actor context required", instance);
  return actor;
}
