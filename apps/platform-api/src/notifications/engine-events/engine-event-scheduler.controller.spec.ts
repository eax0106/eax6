import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { EngineEventNotificationRunner } from "./engine-event-notification.runner";
import type { DriftSuggestionRunner } from "./drift-suggestion.runner";
import { EngineEventSchedulerController } from "./engine-event-scheduler.controller";

const TOKEN = "real-shared-secret";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function setup() {
  const runner = {
    run: vi.fn(async () => ({ tenants: 2, tenantsFailed: 1, notificationsCreated: 5 })),
  } as unknown as EngineEventNotificationRunner;
  const drift = { run: vi.fn(async () => 3) } as unknown as DriftSuggestionRunner;
  return { runner, drift, controller: new EngineEventSchedulerController(runner, drift, HASH) };
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

  describe("drift suggestions (section 17)", () => {
    const valid = {
      tenant_id: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1",
      agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a1",
      task_class: "summarisation",
      action_taken: "weight_decay",
    };

    it("refuses without the shared secret and does not run", async () => {
      const { controller, drift } = setup();
      await expect(controller.driftSuggestion(valid, "Bearer wrong")).rejects.toMatchObject({ status: 401 });
      expect(drift.run).not.toHaveBeenCalled();
    });

    it.each([
      [{ ...valid, tenant_id: "ten_x" }],
      [{ ...valid, agent_id: "agt_1" }],
      [{ ...valid, task_class: "<b>x</b>" }],
      [{ ...valid, action_taken: "none" }],
      [null],
    ])("refuses a malformed report (%#)", async (body) => {
      const { controller, drift } = setup();
      await expect(controller.driftSuggestion(body, `Bearer ${TOKEN}`)).rejects.toMatchObject({ status: 400 });
      expect(drift.run).not.toHaveBeenCalled();
    });

    it("runs a valid report and relays the count", async () => {
      const { controller, drift } = setup();
      await expect(controller.driftSuggestion(valid, `Bearer ${TOKEN}`)).resolves.toEqual({ notifications_created: 3 });
      expect(drift.run).toHaveBeenCalledWith({
        tenantId: valid.tenant_id,
        agentId: valid.agent_id,
        taskClass: "summarisation",
        action: "weight_decay",
      });
    });
  });
});
