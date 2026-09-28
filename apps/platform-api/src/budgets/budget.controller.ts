import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { BudgetService } from "./budget.service";
import { BudgetHttpError } from "./problem";
import type { BudgetActor, BudgetView } from "./types";
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
    return this.budgets.list(budgetActor(actor, BASE), actor!, traceparent);
  }

  @Post()
  @HttpCode(201)
  @RequireWorkspaceRole("admin")
  @RequirePermission("budgets:write")
  @Idempotent()
  create(@Body() body: unknown, @ActorContext() actor: ActorContextType | undefined): Promise<BudgetView> {
    return this.budgets.create(budgetActor(actor, BASE), parseCreateBudget(body, BASE));
  }

  @Patch(":budgetId")
  @RequireWorkspaceRole("admin")
  @RequirePermission("budgets:write")
  update(
    @Param("budgetId") budgetId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<BudgetView> {
    const instance = `${BASE}/${budgetId}`;
    return this.budgets.update(budgetActor(actor, instance), parseBudgetId(budgetId, instance), parseUpdateBudget(body, instance), instance);
  }

  @Delete(":budgetId")
  @HttpCode(204)
  @RequireWorkspaceRole("admin")
  @RequirePermission("budgets:write")
  remove(@Param("budgetId") budgetId: string, @ActorContext() actor: ActorContextType | undefined): Promise<void> {
    const instance = `${BASE}/${budgetId}`;
    return this.budgets.remove(budgetActor(actor, instance), parseBudgetId(budgetId, instance), instance);
  }
}

function budgetActor(actor: ActorContextType | undefined, instance: string): BudgetActor {
  if (!actor) throw new BudgetHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
  if (!actor.workspace_id) throw new BudgetHttpError(403, "BUDGET_WORKSPACE_REQUIRED", "Workspace actor context required", instance);
  return { tenantId: actor.tenant_id, workspaceId: actor.workspace_id, userId: actor.user_id };
}
