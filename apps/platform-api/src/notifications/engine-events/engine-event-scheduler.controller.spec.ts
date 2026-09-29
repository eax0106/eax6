import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { EngineEventNotificationRunner } from "./engine-event-notification.runner";
import { EngineEventSchedulerController } from "./engine-event-scheduler.controller";

const TOKEN = "real-shared-secret";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function setup() {
  const runner = {
    run: vi.fn(async () => ({ tenants: 2, tenantsFailed: 1, notificationsCreated: 5 })),
  } as unknown as EngineEventNotificationRunner;
  return { runner, controller: new EngineEventSchedulerController(runner, HASH) };
}

describe("EngineEventSchedulerController", () => {
  it.each([undefined, "", "Bearer wrong-token", "Basic abc", "Bearer "])(
    "refuses %j and does not read the engine",
    async (header) => {
      const { controller, runner } = setup();
      await expect(controller.run(header)).rejects.toThrow(HttpException);
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it("answers a refusal 401", async () => {
    const { controller } = setup();
    await expect(controller.run("Bearer wrong")).rejects.toMatchObject({ status: 401 });
  });

  it("accepts the shared secret and relays the counts", async () => {
    const { controller, runner } = setup();
    await expect(controller.run(`Bearer ${TOKEN}`)).resolves.toEqual({
      tenants: 2,
      tenants_failed: 1,
      notifications_created: 5,
    });
    expect(runner.run).toHaveBeenCalledOnce();
  });
});
