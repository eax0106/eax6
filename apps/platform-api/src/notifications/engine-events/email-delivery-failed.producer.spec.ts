import { describe, expect, it, vi } from "vitest";
import type { EngineCallerContext, EngineClient } from "../../engine";
import type { NotificationService } from "../notification.service";
import { EmailDeliveryFailedProducer } from "./email-delivery-failed.producer";
import { EngineEventNotificationModule } from "./engine-event-notification.module";
import { ENGINE_EVENT_PRODUCERS } from "./engine-event-producer";

const tenantId = "00000000-0000-7000-8000-000000000001", workspace = "00000000-0000-7000-8000-000000000002";
const caller = { userId: "system:platform-jobs" } as unknown as EngineCallerContext;
const context = { tenantId, caller, now: new Date("2026-10-01T10:00:00Z") };
const failure = (id = "sfx_1") => ({ id, run_id: "run_old", workspace_id: `ws_${workspace}` });
function setup() {
  const get = vi.fn().mockResolvedValue({ body: { data: [failure()], page: { next_cursor: null } } });
  const notifyWorkspaceRolesOnce = vi.fn().mockResolvedValue(1);
  return { get, notifyWorkspaceRolesOnce, producer: new EmailDeliveryFailedProducer({ get } as unknown as EngineClient, { notifyWorkspaceRolesOnce } as unknown as NotificationService) };
}
describe("D14 notifications through the D1 read-only caller", () => {
  it("pages late failures, dedupes each email independently and reads with the real caller", async () => {
    const { get, notifyWorkspaceRolesOnce, producer } = setup();
    get.mockResolvedValueOnce({ body: { data: [failure()], page: { next_cursor: "sfx_1" } } })
      .mockResolvedValueOnce({ body: { data: [failure("sfx_2")], page: { next_cursor: null } } });
    const keys = new Set<string>();
    notifyWorkspaceRolesOnce.mockImplementation(async (_roles, key: string) => { if (keys.has(key)) return 0; keys.add(key); return 1; });
    expect(await producer.produce(context)).toBe(2);
    expect(get.mock.calls).toEqual([["/api/v1/email-delivery-failures", caller], ["/api/v1/email-delivery-failures?cursor=sfx_1", caller]]);
    expect([...keys]).toEqual(["email.delivery-failed:sfx_1", "email.delivery-failed:sfx_2"]);
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledWith(["admin", "editor"], "email.delivery-failed:sfx_1", expect.objectContaining({
      tenantId, workspaceId: workspace, severity: "critical", title: "Email delivery failed", deepLink: "/app/runs/run_old",
    }));
    expect(await producer.produce(context)).toBe(0);
  });
  it("keeps failed notices retryable and skips malformed routing", async () => {
    const { get, notifyWorkspaceRolesOnce, producer } = setup();
    get.mockResolvedValueOnce({ body: { data: [{ ...failure(), workspace_id: null }, failure(), failure("sfx_2")], page: { next_cursor: null } } });
    notifyWorkspaceRolesOnce.mockRejectedValueOnce(new Error("temporarily unavailable"));
    expect(await producer.produce(context)).toBe(1);
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledTimes(2);
    expect(await producer.produce(context)).toBe(1);
  });
  it("rejects non-advancing pages and passes engine failure to the runner", async () => {
    const { get, producer } = setup();
    get.mockResolvedValue({ body: { data: [failure()], page: { next_cursor: "same" } } });
    await expect(producer.produce(context)).rejects.toThrow("cursor did not advance");
    get.mockRejectedValueOnce(new Error("engine 503"));
    await expect(producer.produce(context)).rejects.toThrow("engine 503");
  });
  it("is registered in the production runner", () => {
    const providers = Reflect.getMetadata("providers", EngineEventNotificationModule) as unknown[];
    expect(providers).toContain(EmailDeliveryFailedProducer);
    const entry = providers.find(value => typeof value === "object" && value !== null && "provide" in value && value.provide === ENGINE_EVENT_PRODUCERS) as { inject: unknown[]; useFactory: (...args: unknown[]) => unknown[] };
    expect(entry.inject).toContain(EmailDeliveryFailedProducer);
    const instances = entry.inject.map(provider => ({ provider }));
    expect(entry.useFactory(...instances)).toContain(instances[entry.inject.indexOf(EmailDeliveryFailedProducer)]);
  });
});
