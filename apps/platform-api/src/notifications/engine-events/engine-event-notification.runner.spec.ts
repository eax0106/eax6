import { describe, expect, it, vi } from "vitest";
import { isSystemCallerContext } from "../../system-jobs/system-caller";
import { EngineEventNotificationRunner } from "./engine-event-notification.runner";
import type { EngineEventProducer } from "./engine-event-producer";
import type { SystemNotificationStore } from "../system-notification-store";

const NOW = new Date("2026-09-29T12:00:00.000Z");

function setup(tenantIds: string[], producers: EngineEventProducer[]) {
  const store = { listActiveTenantIds: vi.fn().mockResolvedValue(tenantIds) } as unknown as SystemNotificationStore;
  return new EngineEventNotificationRunner(store, producers);
}

describe("EngineEventNotificationRunner", () => {
  it("runs every producer for every live tenant as the system caller, bound to that tenant", async () => {
    const seen: { tenantId: string; system: boolean; caller: string }[] = [];
    const producer: EngineEventProducer = {
      name: "p",
      produce: async ({ tenantId, caller }) => {
        seen.push({ tenantId, system: isSystemCallerContext(caller), caller: caller.tenantId });
        return 1;
      },
    };
    const runner = setup(["t1", "t2"], [producer, { ...producer, name: "q" }]);

    const result = await runner.run(NOW);

    expect(result).toEqual({ tenants: 2, tenantsFailed: 0, notificationsCreated: 4 });
    expect(seen).toEqual([
      { tenantId: "t1", system: true, caller: "t1" },
      { tenantId: "t1", system: true, caller: "t1" },
      { tenantId: "t2", system: true, caller: "t2" },
      { tenantId: "t2", system: true, caller: "t2" },
    ]);
  });

  it("a failing producer or tenant never stops the rest and is counted", async () => {
    const good = vi.fn().mockResolvedValue(3);
    const bad = vi.fn().mockRejectedValue(new Error("engine 503"));
    const runner = setup(
      ["t1", "t2"],
      [
        { name: "bad", produce: bad },
        { name: "good", produce: good },
      ],
    );

    const result = await runner.run(NOW);

    expect(result).toEqual({ tenants: 2, tenantsFailed: 2, notificationsCreated: 6 });
    expect(good).toHaveBeenCalledTimes(2);
  });

  it("gives each producer the pass's time", async () => {
    const produce = vi.fn().mockResolvedValue(0);
    await setup(["t1"], [{ name: "p", produce }]).run(NOW);
    expect(produce.mock.calls[0]![0].now).toBe(NOW);
  });

  it("does nothing, quietly, when there are no live tenants", async () => {
    const produce = vi.fn();
    await expect(setup([], [{ name: "p", produce }]).run(NOW)).resolves.toEqual({
      tenants: 0,
      tenantsFailed: 0,
      notificationsCreated: 0,
    });
    expect(produce).not.toHaveBeenCalled();
  });

  it("fails loudly when tenants cannot be listed (the system pool is not configured)", async () => {
    const store = {
      listActiveTenantIds: vi.fn().mockRejectedValue(new Error("no system pool")),
    } as unknown as SystemNotificationStore;
    await expect(new EngineEventNotificationRunner(store, []).run(NOW)).rejects.toThrow("no system pool");
  });
});
