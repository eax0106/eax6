import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";

import {
  BudgetConflictError,
  BudgetNotFoundError,
  BudgetStaleError,
  BudgetValidationError,
  EngineBudgetService,
  type BudgetKind,
  type BudgetMode,
  type BudgetWithUsage,
  type EngineBudgetPeriod,
} from "./budget.service";

const BUDGETS_WRITE = "budgets:write";
const KINDS: readonly BudgetKind[] = ["run_cap", "workflow", "workspace"];
const PERIODS: readonly EngineBudgetPeriod[] = ["daily", "monthly"];
const MODES: readonly BudgetMode[] = ["hard", "warn"];
// Up to 10 crore rupees, in paise.
const MAX_AMOUNT_MINOR = 10_000_000_000;

/**
 * D3: a workspace's budgets, owned by the engine so Run Manager can check them
 * atomically at run start. platform-api relays these routes for the web.
 */
@Controller("api/v1/budgets")
export class BudgetsController {
  constructor(private readonly budgets: EngineBudgetService) {}

  @Get()
  async list(@Req() request: IdentityTenantGatewayRequest) {
    const { tenantId, workspaceId } = scope(request);
    return { data: (await this.run(request, () => this.budgets.list(tenantId, workspaceId))).map(toResponse) };
  }

  /**
   * Every enabled period budget of the tenant with this period's spend, for
   * the platform's 50% and 80% alerts. It crosses workspaces, so it answers
   * the system principal only.
   */
  @Get("threshold-feed")
  async thresholdFeed(@Req() request: IdentityTenantGatewayRequest) {
    const actor = request.actorContext;
    if (actor === undefined) {
      throw new HttpException(problem(request.url, 500, "BUDGETS_INTERNAL", "Missing authenticated tenant context"), 500);
    }
    if (actor.actor_type !== "system") {
      throw new HttpException(problem(request.url, 403, "BUDGET_FEED_SYSTEM_ONLY", "This feed is for the platform's background jobs"), 403);
    }
    const rows = await this.run(request, () => this.budgets.thresholdFeed(actor.tenant_id));
    return {
      data: rows.map((row) => ({
        id: row.id,
        workspace_id: `ws_${row.workspace_id}`,
        workflow_id: row.workflow_id,
        kind: row.kind,
        period: row.period,
        period_key: row.period_key,
        amount_minor: Number(row.amount_minor),
        spent_minor: Number(row.spent_minor),
      })),
    };
  }

  @Post()
  @HttpCode(201)
  async create(@Req() request: IdentityTenantGatewayRequest, @Body() body: unknown) {
    const { tenantId, workspaceId, userId } = writer(request);
    const input = record(body, request.url);
    allowOnly(input, ["kind", "workflow_id", "period", "amount_minor", "mode"], request.url);
    const kind = oneOf(input.kind, KINDS, "kind", request.url);
    const created = await this.run(request, () =>
      this.budgets.create(tenantId, {
        workspaceId,
        kind,
        ...(input.workflow_id === undefined ? {} : { workflowId: text(input.workflow_id, "workflow_id", request.url) }),
        ...(input.period === undefined ? {} : { period: oneOf(input.period, PERIODS, "period", request.url) }),
        amountMinor: amount(input.amount_minor, request.url),
        ...(input.mode === undefined ? {} : { mode: oneOf(input.mode, MODES, "mode", request.url) }),
        createdBy: userId,
      }),
    );
    return toResponse({ ...created, spent_minor: created.period === null ? null : "0", reserved_minor: created.period === null ? null : "0" });
  }

  @Patch(":budgetId")
  async update(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("budgetId") budgetId: string,
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ) {
    const { tenantId, workspaceId } = writer(request);
    if (ifMatch === undefined || ifMatch.trim().length === 0) {
      throw new HttpException(problem(request.url, 428, "BUDGET_IF_MATCH_REQUIRED", "If-Match with the budget's updated_at is required"), 428);
    }
    const input = record(body, request.url);
    allowOnly(input, ["amount_minor", "mode", "enabled"], request.url);
    if (Object.keys(input).length === 0) throw badRequest(request.url, "at least one of amount_minor, mode, enabled is required");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw badRequest(request.url, "enabled must be true or false");
    await this.run(request, () =>
      this.budgets.update(tenantId, workspaceId, budgetId, {
        ...(input.amount_minor === undefined ? {} : { amountMinor: amount(input.amount_minor, request.url) }),
        ...(input.mode === undefined ? {} : { mode: oneOf(input.mode, MODES, "mode", request.url) }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
      }, ifMatch.trim()),
    );
    const listed = await this.run(request, () => this.budgets.list(tenantId, workspaceId));
    const updated = listed.find((budget) => budget.id === budgetId);
    if (updated === undefined) throw new HttpException(problem(request.url, 404, "BUDGET_NOT_FOUND", `Budget ${budgetId} was not found`), 404);
    return toResponse(updated);
  }

  @Delete(":budgetId")
  @HttpCode(204)
  async remove(@Req() request: IdentityTenantGatewayRequest, @Param("budgetId") budgetId: string): Promise<void> {
    const { tenantId, workspaceId } = writer(request);
    const listed = await this.run(request, () => this.budgets.list(tenantId, workspaceId));
    if (!listed.some((budget) => budget.id === budgetId)) {
      throw new HttpException(problem(request.url, 404, "BUDGET_NOT_FOUND", `Budget ${budgetId} was not found`), 404);
    }
    await this.run(request, () => this.budgets.delete(tenantId, workspaceId, budgetId));
  }

  private async run<T>(request: IdentityTenantGatewayRequest, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      if (error instanceof BudgetValidationError) throw badRequest(request.url, error.message);
      if (error instanceof BudgetNotFoundError) throw new HttpException(problem(request.url, 404, "BUDGET_NOT_FOUND", error.message), 404);
      if (error instanceof BudgetConflictError) throw new HttpException(problem(request.url, 409, "BUDGET_CONFLICT", error.message), 409);
      if (error instanceof BudgetStaleError) throw new HttpException(problem(request.url, 412, "BUDGET_STALE", error.message), 412);
      throw new HttpException(problem(request.url, 500, "BUDGETS_INTERNAL", "Budgets could not be read or written"), 500);
    }
  }
}

function toResponse(budget: BudgetWithUsage) {
  return {
    id: budget.id,
    workspace_id: `ws_${budget.workspace_id}`,
    workflow_id: budget.workflow_id,
    kind: budget.kind,
    period: budget.period,
    currency: "INR" as const,
    amount_minor: Number(budget.amount_minor),
    mode: budget.mode,
    enabled: budget.enabled,
    spent_minor: budget.spent_minor === null ? null : Number(budget.spent_minor),
    reserved_minor: budget.reserved_minor === null ? null : Number(budget.reserved_minor),
    created_by: budget.created_by,
    created_at: budget.created_at,
    updated_at: budget.updated_at,
  };
}

function scope(request: IdentityTenantGatewayRequest): { tenantId: string; workspaceId: string } {
  const actor = request.actorContext;
  if (actor === undefined || actor.workspace_id === null || actor.workspace_id === undefined) {
    throw new HttpException(problem(request.url, 500, "BUDGETS_INTERNAL", "Missing authenticated workspace context"), 500);
  }
  return { tenantId: actor.tenant_id, workspaceId: actor.workspace_id };
}

/** Writing a budget needs a person holding budgets:write; the platform checks the role, this checks the grant again. */
function writer(request: IdentityTenantGatewayRequest): { tenantId: string; workspaceId: string; userId: string } {
  const { tenantId, workspaceId } = scope(request);
  const actor = request.actorContext!;
  if (actor.user_id === null || !actor.permissions.includes(BUDGETS_WRITE)) {
    throw new HttpException(problem(request.url, 403, "BUDGETS_WRITE_REQUIRED", "Changing a budget needs budgets:write"), 403);
  }
  return { tenantId, workspaceId, userId: actor.user_id };
}

function record(body: unknown, instance: string | undefined): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw badRequest(instance, "a JSON object body is required");
  return body as Record<string, unknown>;
}

function allowOnly(input: Record<string, unknown>, fields: readonly string[], instance: string | undefined): void {
  const extra = Object.keys(input).filter((key) => !fields.includes(key));
  if (extra.length > 0) throw badRequest(instance, `unknown field ${extra[0]}`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, instance: string | undefined): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw badRequest(instance, `${field} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function text(value: unknown, field: string, instance: string | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw badRequest(instance, `${field} must be a string`);
  return value;
}

function amount(value: unknown, instance: string | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT_MINOR) {
    throw badRequest(instance, "amount_minor must be a positive whole number of paise");
  }
  return value;
}

function badRequest(instance: string | undefined, detail: string): HttpException {
  return new HttpException(problem(instance, 400, "BUDGET_VALIDATION_FAILED", detail), 400);
}

function problem(
  instance: string | undefined,
  status: 400 | 403 | 404 | 409 | 412 | 428 | 500,
  errorCode: string,
  detail: string,
): ProblemDetails {
  const titles = {
    400: "Bad Request",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    412: "Precondition Failed",
    428: "Precondition Required",
    500: "Internal Server Error",
  } as const;
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: titles[status],
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "budgets",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
