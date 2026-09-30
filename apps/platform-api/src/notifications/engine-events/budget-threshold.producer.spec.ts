import { describe, expect, it, vi } from "vitest";
import type { EngineCallerContext, EngineClient } from "../../engine";
import type { NotificationService } from "../notification.service";
import { BudgetThresholdProducer } from "./budget-threshold.producer";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const caller = { userId: "system:platform-jobs" } as unknown as EngineCallerContext;
const tenantId = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-0000000000a1";

const budget = (id: string, spent: number, extra: Record<string, unknown> = {}) => ({
  id,
  workspace_id: `ws_${workspace}`,
  workflow_id: null,
  kind: "workspace",
  period: "monthly",
  period_key: "2026-09",
  amount_minor: 1_000,
  spent_minor: spent,
  ...extra,
});

function setup(data: unknown[]) {
  const get = vi.fn().mockResolvedValue({ body: { data } });
  const notifyWorkspaceRolesOnce = vi.fn().mockResolvedValue(1);
  const producer = new BudgetThresholdProducer(
    { get } as unknown as EngineClient,
    { notifyWorkspaceRolesOnce } as unknown as NotificationService,
  );
  return { get, notifyWorkspaceRolesOnce, producer };
}

describe("BudgetThresholdProducer (D3)", () => {
  it("reads the engine's threshold feed as the system caller", async () => {
    const { get, producer } = setup([]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(get).toHaveBeenCalledWith("/api/v1/budgets/threshold-feed", caller);
  });

  it("announces the highest threshold reached, once per budget, period and threshold", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      budget("bud_under", 499),
      budget("bud_half", 500),
      budget("bud_both", 850, { kind: "workflow", period: "daily", period_key: "2026-09-29" }),
    ]);

    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(2);

    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledTimes(2);
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledWith(
      ["admin"],
      "budget:bud_half:2026-09:50",
      expect.objectContaining({ tenantId, workspaceId: workspace, eventClass: "budget", severity: "info", title: "Budget 50% used", deepLink: "/app/usage/budgets" }),
    );
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledWith(
      ["admin"],
      "budget:bud_both:2026-09-29:80",
      expect.objectContaining({ severity: "warning", title: "Budget 80% used", body: "A workflow's daily budget has reached 80% of its limit." }),
    );
  });

  it("skips a malformed row and keeps going when one notification fails", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      budget("bud_bad", 900, { amount_minor: 0 }),
      budget("bud_nows", 900, { workspace_id: null }),
      budget("bud_fails", 900),
      budget("bud_ok", 900),
    ]);
    notifyWorkspaceRolesOnce.mockRejectedValueOnce(new Error("db down"));

    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(1);
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledTimes(2);
  });
});
