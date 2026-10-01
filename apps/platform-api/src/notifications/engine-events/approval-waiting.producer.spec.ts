import { describe, expect, it, vi } from "vitest";
import type { EngineCallerContext, EngineClient } from "../../engine";
import type { NotificationService } from "../notification.service";
import { ApprovalWaitingProducer } from "./approval-waiting.producer";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const caller = { userId: "system:platform-jobs" } as unknown as EngineCallerContext;
const tenantId = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-0000000000a1";

const approval = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "pending",
  workspace_id: `ws_${workspace}`,
  requested_action: "send the invoice email to a customer",
  ...extra,
});
const page = (data: unknown[], next: string | null = null) => ({
  body: { data, page: { next_cursor: next, has_more: next !== null, limit: 50 } },
});

function setup(pages: unknown[]) {
  const get = vi.fn();
  pages.forEach((p) => get.mockResolvedValueOnce(p));
  const notifyWorkspaceRolesOnce = vi.fn().mockResolvedValue(1);
  const producer = new ApprovalWaitingProducer(
    { get } as unknown as EngineClient,
    { notifyWorkspaceRolesOnce } as unknown as NotificationService,
  );
  return { get, notifyWorkspaceRolesOnce, producer };
}

describe("ApprovalWaitingProducer", () => {
  it("asks the engine for pending approvals as the system caller", async () => {
    const { get, producer } = setup([page([])]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(get).toHaveBeenCalledWith("/api/v1/approvals?status=pending&limit=50", caller);
  });

  it("tells workspace admins, operators and approvers once per pending approval, linking to it", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([approval("apr_1")])]);

    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(1);

    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledWith(
      ["admin", "operator", "approver"],
      "approval.requested:apr_1",
      expect.objectContaining({
        tenantId,
        workspaceId: workspace,
        eventClass: "approval",
        severity: "warning",
        deepLink: "/app/human-actions/apr_1",
        sourceService: "platform-api.engine-events",
      }),
    );
  });

  it("does not put what the approval is for in the notification", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([approval("apr_1")])]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(JSON.stringify(notifyWorkspaceRolesOnce.mock.calls[0]![2])).not.toContain("invoice");
  });

  it("skips an approval with no workspace instead of guessing one", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([approval("apr_1", { workspace_id: null })])]);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(0);
    expect(notifyWorkspaceRolesOnce).not.toHaveBeenCalled();
  });

  it("follows the cursor, up to four pages", async () => {
    const { get, producer } = setup([
      page([approval("a")], "a"),
      page([approval("b")], "b"),
      page([approval("c")], "c"),
      page([approval("d")], "d"),
      page([approval("e")], "e"),
    ]);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(4);
    expect(get).toHaveBeenCalledTimes(4);
    expect(get).toHaveBeenNthCalledWith(2, "/api/v1/approvals?status=pending&limit=50&cursor=a", caller);
  });

  it("one failed notification does not stop the others", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([approval("bad"), approval("good")])]);
    notifyWorkspaceRolesOnce.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(2);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(2);
  });

  it("lets an engine failure reach the runner, which counts it", async () => {
    const producer = new ApprovalWaitingProducer(
      { get: vi.fn().mockRejectedValue(new Error("engine 503")) } as unknown as EngineClient,
      {} as unknown as NotificationService,
    );
    await expect(producer.produce({ tenantId, caller, now: NOW })).rejects.toThrow("engine 503");
  });
});
