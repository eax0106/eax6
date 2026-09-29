import { describe, expect, it, vi } from "vitest";
import type { EngineCallerContext, EngineClient } from "../../engine";
import type { NotificationService } from "../notification.service";
import { SelfHealProducer } from "./self-heal.producer";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const caller = { userId: "system:platform-jobs" } as unknown as EngineCallerContext;
const tenantId = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-0000000000a1";

const action = (id: string, runId: string, extra: Record<string, unknown> = {}) => ({
  id,
  run_id: runId,
  workspace_id: `ws_${workspace}`,
  strategy: "retry",
  outcome: "resolved",
  ...extra,
});
const page = (data: unknown[], next: string | null = null) => ({
  body: { data, page: { next_cursor: next, has_more: next !== null, limit: 50 } },
});

function setup(pages: unknown[]) {
  const get = vi.fn();
  pages.forEach((p) => get.mockResolvedValueOnce(p));
  const notifyWorkspaceRolesOnce = vi.fn().mockResolvedValue(1);
  const producer = new SelfHealProducer(
    { get } as unknown as EngineClient,
    { notifyWorkspaceRolesOnce } as unknown as NotificationService,
  );
  return { get, notifyWorkspaceRolesOnce, producer };
}

describe("SelfHealProducer", () => {
  it("asks the engine for repairs from the last two hours as the system caller", async () => {
    const { get, producer } = setup([page([])]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(get).toHaveBeenCalledWith(
      "/api/v1/recovery-actions?resolved_after=2026-09-29T10%3A00%3A00.000Z&limit=50",
      caller,
    );
  });

  it("tells workspace admins and editors once per run, as information, linking to the run", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([action("rec_1", "run_1")])]);

    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(1);

    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledWith(
      ["admin", "editor"],
      "self-heal:run_1",
      expect.objectContaining({
        tenantId,
        workspaceId: workspace,
        eventClass: "workflow",
        severity: "info",
        deepLink: "/app/runs/run_1",
      }),
    );
  });

  it("keys the notice on the run, so several repairs of one run are one notice", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      page([action("rec_1", "run_1"), action("rec_2", "run_1"), action("rec_3", "run_2")]),
    ]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(notifyWorkspaceRolesOnce.mock.calls.map((c) => c[1])).toEqual([
      "self-heal:run_1",
      "self-heal:run_1",
      "self-heal:run_2",
    ]);
  });

  it("does not put the failure class or strategy in the notification", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      page([action("rec_1", "run_1", { failure_class: "credential_missing", strategy: "swap_agent" })]),
    ]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(JSON.stringify(notifyWorkspaceRolesOnce.mock.calls[0]![2])).not.toMatch(/credential|swap/);
  });

  it("skips a repair with no run or workspace instead of guessing", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      page([action("rec_1", "run_1", { workspace_id: null }), action("rec_2", "run_2", { run_id: null })]),
    ]);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(0);
    expect(notifyWorkspaceRolesOnce).not.toHaveBeenCalled();
  });

  it("follows the cursor, up to four pages", async () => {
    const { get, producer } = setup([
      page([action("a", "r1")], "a"),
      page([action("b", "r2")], "b"),
      page([action("c", "r3")], "c"),
      page([action("d", "r4")], "d"),
      page([action("e", "r5")], "e"),
    ]);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(4);
    expect(get).toHaveBeenCalledTimes(4);
    expect(String(get.mock.calls[1]![0])).toContain("&cursor=a");
  });

  it("one failed notification does not stop the others", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([action("a", "r1"), action("b", "r2")])]);
    notifyWorkspaceRolesOnce.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(2);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(2);
  });

  it("lets an engine failure reach the runner, which counts it", async () => {
    const producer = new SelfHealProducer(
      { get: vi.fn().mockRejectedValue(new Error("engine 503")) } as unknown as EngineClient,
      {} as unknown as NotificationService,
    );
    await expect(producer.produce({ tenantId, caller, now: NOW })).rejects.toThrow("engine 503");
  });
});
