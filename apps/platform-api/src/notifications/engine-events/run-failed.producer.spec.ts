import { describe, expect, it, vi } from "vitest";
import type { EngineClient, EngineCallerContext } from "../../engine";
import type { NotificationService } from "../notification.service";
import { RunFailedProducer } from "./run-failed.producer";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const caller = { userId: "system:platform-jobs" } as unknown as EngineCallerContext;
const tenantId = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-0000000000a1";

function run(id: string, endedMinutesAgo: number | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "failed",
    workspace_id: `ws_${workspace}`,
    created_at: minutesAgo((endedMinutesAgo ?? 0) + 5),
    ended_at: endedMinutesAgo === null ? null : minutesAgo(endedMinutesAgo),
    ...extra,
  };
}

function page(data: unknown[], next: string | null = null) {
  return { body: { data, page: { next_cursor: next, has_more: next !== null, limit: 50 } } };
}

function setup(pages: unknown[]) {
  const get = vi.fn();
  pages.forEach((p) => get.mockResolvedValueOnce(p));
  const notifyWorkspaceRolesOnce = vi.fn().mockResolvedValue(1);
  const producer = new RunFailedProducer(
    { get } as unknown as EngineClient,
    { notifyWorkspaceRolesOnce } as unknown as NotificationService,
  );
  return { get, notifyWorkspaceRolesOnce, producer };
}

describe("RunFailedProducer", () => {
  it("asks the engine for failed runs as the system caller", async () => {
    const { get, producer } = setup([page([])]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(get).toHaveBeenCalledWith("/api/v1/runs?status=failed&limit=50", caller);
  });

  it("tells workspace admins and editors once per recently failed run, with the bare workspace id", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([run("run_1", 10)])]);

    const created = await producer.produce({ tenantId, caller, now: NOW });

    expect(created).toBe(1);
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledWith(
      ["admin", "editor"],
      "run.failed:run_1",
      expect.objectContaining({
        tenantId,
        workspaceId: workspace,
        eventClass: "workflow",
        severity: "critical",
        deepLink: "/app/runs/run_1",
        sourceService: "platform-api.engine-events",
      }),
    );
  });

  it("does not put run content, workflow names or errors in the notification", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      page([run("run_1", 10, { error: "secret failure text", goal: "Pay Acme invoice" })]),
    ]);
    await producer.produce({ tenantId, caller, now: NOW });
    const input = notifyWorkspaceRolesOnce.mock.calls[0]![2];
    expect(JSON.stringify(input)).not.toMatch(/secret failure|Acme/);
  });

  it("skips a run that failed longer ago than the look-back, and one that has not ended", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      page([run("old", 180), run("open", null), run("fresh", 30)]),
    ]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(notifyWorkspaceRolesOnce.mock.calls.map((c) => c[1])).toEqual(["run.failed:fresh"]);
  });

  it("skips a run with no workspace instead of guessing one", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([
      page([run("run_1", 10, { workspace_id: null })]),
    ]);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(0);
    expect(notifyWorkspaceRolesOnce).not.toHaveBeenCalled();
  });

  it("follows the cursor while runs are still inside the created window", async () => {
    const { get, producer } = setup([page([run("run_1", 10)], "run_1"), page([run("run_2", 20)])]);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(2);
    expect(get).toHaveBeenNthCalledWith(2, "/api/v1/runs?status=failed&limit=50&cursor=run_1", caller);
  });

  it("stops paging once a page reaches runs created before the created window", async () => {
    const stale = run("ancient", 3000, { created_at: minutesAgo(3000) });
    const { get, producer } = setup([page([stale], "ancient"), page([run("never", 10)])]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("never reads more than four pages", async () => {
    const { get, producer } = setup([
      page([run("a", 10)], "a"),
      page([run("b", 10)], "b"),
      page([run("c", 10)], "c"),
      page([run("d", 10)], "d"),
      page([run("e", 10)], "e"),
    ]);
    await producer.produce({ tenantId, caller, now: NOW });
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("one failed notification does not stop the others", async () => {
    const { notifyWorkspaceRolesOnce, producer } = setup([page([run("bad", 10), run("good", 10)])]);
    notifyWorkspaceRolesOnce.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(2);
    await expect(producer.produce({ tenantId, caller, now: NOW })).resolves.toBe(2);
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledTimes(2);
  });

  it("lets an engine failure reach the runner, which counts it", async () => {
    const get = vi.fn().mockRejectedValue(new Error("engine 503"));
    const producer = new RunFailedProducer(
      { get } as unknown as EngineClient,
      {} as unknown as NotificationService,
    );
    await expect(producer.produce({ tenantId, caller, now: NOW })).rejects.toThrow("engine 503");
  });
});
