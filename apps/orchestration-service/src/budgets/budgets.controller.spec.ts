import { describe, expect, it, vi } from "vitest";

import { BudgetNotFoundError, BudgetStaleError, BudgetValidationError, type EngineBudgetService } from "./budget.service";
import { BudgetsController } from "./budgets.controller";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const WORKSPACE = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const BUDGET = "bud_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";

function request(overrides: Record<string, unknown> = {}) {
  return {
    url: "/api/v1/budgets",
    actorContext: {
      actor_type: "user",
      user_id: "usr_1",
      tenant_id: TENANT,
      workspace_id: WORKSPACE,
      roles: ["admin"],
      permissions: ["budgets:write", "billing:read"],
      session_id: "s",
      jti: "j",
      ...overrides,
    },
  } as never;
}

const row = {
  id: BUDGET,
  workspace_id: WORKSPACE.slice(3),
  workflow_id: null,
  kind: "workspace" as const,
  period: "monthly" as const,
  amount_minor: "100000",
  mode: "hard" as const,
  enabled: true,
  created_by: "usr_1",
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
  spent_minor: "250",
  reserved_minor: "40",
};

function service(overrides: Partial<Record<keyof EngineBudgetService, unknown>> = {}) {
  return {
    list: vi.fn(async () => [row]),
    create: vi.fn(async () => row),
    update: vi.fn(async () => row),
    delete: vi.fn(async () => undefined),
    thresholdFeed: vi.fn(async () => []),
    ...overrides,
  } as unknown as EngineBudgetService & Record<string, ReturnType<typeof vi.fn>>;
}

describe("BudgetsController (D3)", () => {
  it("lists the caller's workspace budgets with this period's spend", async () => {
    const budgets = service();
    const response = await new BudgetsController(budgets).list(request());
    expect(budgets.list).toHaveBeenCalledWith(TENANT, WORKSPACE);
    expect(response.data[0]).toMatchObject({ id: BUDGET, workspace_id: WORKSPACE, currency: "INR", amount_minor: 100000, spent_minor: 250, reserved_minor: 40 });
  });

  it("creates a budget in the caller's workspace, recording who made it", async () => {
    const budgets = service();
    await new BudgetsController(budgets).create(request(), { kind: "workflow", workflow_id: "wf_1", period: "daily", amount_minor: 500, mode: "warn" });
    expect(budgets.create).toHaveBeenCalledWith(TENANT, {
      workspaceId: WORKSPACE,
      kind: "workflow",
      workflowId: "wf_1",
      period: "daily",
      amountMinor: 500,
      mode: "warn",
      createdBy: "usr_1",
    });
  });

  it.each([
    ["no budgets:write", { permissions: ["billing:read"] }],
    ["a system principal", { actor_type: "system", user_id: null }],
  ])("refuses a write from %s", async (_name, overrides) => {
    const budgets = service();
    await expect(new BudgetsController(budgets).create(request(overrides), { kind: "workspace", amount_minor: 5 })).rejects.toMatchObject({ status: 403 });
    expect(budgets.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "yearly", amount_minor: 5 }],
    [{ kind: "workspace", amount_minor: 0 }],
    [{ kind: "workspace", amount_minor: 1.5 }],
    [{ kind: "workspace", amount_minor: 5, workspace_id: "ws_other" }],
    [{ kind: "workspace", amount_minor: 5, mode: "block" }],
  ])("refuses a malformed budget before storing it (%#)", async (body) => {
    const budgets = service();
    await expect(new BudgetsController(budgets).create(request(), body)).rejects.toMatchObject({ status: 400 });
    expect(budgets.create).not.toHaveBeenCalled();
  });

  it("maps the store's refusals: invalid 400, missing 404", async () => {
    const invalid = service({ create: vi.fn(async () => { throw new BudgetValidationError("the workflow does not exist"); }) });
    await expect(new BudgetsController(invalid).create(request(), { kind: "run_cap", workflow_id: "wf_x", amount_minor: 5 })).rejects.toMatchObject({ status: 400 });
    const missing = service({ update: vi.fn(async () => { throw new BudgetNotFoundError(BUDGET); }) });
    await expect(new BudgetsController(missing).update(request(), BUDGET, { enabled: false }, row.updated_at)).rejects.toMatchObject({ status: 404 });
  });

  it("changes a budget only with If-Match: 428 without it, 412 when stale", async () => {
    const budgets = service();
    await expect(new BudgetsController(budgets).update(request(), BUDGET, { enabled: false })).rejects.toMatchObject({ status: 428 });
    expect(budgets.update).not.toHaveBeenCalled();
    await new BudgetsController(budgets).update(request(), BUDGET, { amount_minor: 900 }, row.updated_at);
    expect(budgets.update).toHaveBeenCalledWith(TENANT, WORKSPACE, BUDGET, { amountMinor: 900 }, row.updated_at);
    const stale = service({ update: vi.fn(async () => { throw new BudgetStaleError(BUDGET); }) });
    await expect(new BudgetsController(stale).update(request(), BUDGET, { enabled: false }, "2026-01-01T00:00:00Z")).rejects.toMatchObject({ status: 412 });
  });

  it("deletes only a budget of the caller's workspace", async () => {
    const budgets = service();
    await new BudgetsController(budgets).remove(request(), BUDGET);
    expect(budgets.delete).toHaveBeenCalledWith(TENANT, WORKSPACE, BUDGET);
    await expect(new BudgetsController(budgets).remove(request(), "bud_other")).rejects.toMatchObject({ status: 404 });
  });

  it("answers the threshold feed to the system principal only", async () => {
    const budgets = service({
      thresholdFeed: vi.fn(async () => [
        { id: BUDGET, workspace_id: WORKSPACE.slice(3), workflow_id: null, kind: "workspace", period: "monthly", period_key: "2026-09", amount_minor: "1000", spent_minor: "600" },
      ]),
    });
    await expect(new BudgetsController(budgets).thresholdFeed(request())).rejects.toMatchObject({ status: 403 });
    const feed = await new BudgetsController(budgets).thresholdFeed(request({ actor_type: "system", user_id: null, workspace_id: null }));
    expect(feed.data).toEqual([
      { id: BUDGET, workspace_id: WORKSPACE, workflow_id: null, kind: "workspace", period: "monthly", period_key: "2026-09", amount_minor: 1000, spent_minor: 600 },
    ]);
    expect(budgets.thresholdFeed).toHaveBeenCalledTimes(1);
  });
});
