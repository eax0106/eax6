import { describe, expect, it, vi } from "vitest";
import type { EngineCallerContext, EngineClient } from "../../engine";
import type { NotificationService } from "../notification.service";
import { DeploymentChangedProducer } from "./deployment-changed.producer";
import { EngineEventNotificationModule } from "./engine-event-notification.module";
import { ENGINE_EVENT_PRODUCERS } from "./engine-event-producer";

const tenantId = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-0000000000a1";
const caller = { userId: "system:platform-jobs" } as unknown as EngineCallerContext;
const context = { tenantId, caller, now: new Date("2026-09-29T12:00:00.000Z") };
const change = (extra: Record<string, unknown> = {}) => ({ workflow_id: "wf_1", workflow_version_id: "wfv_1", workspace_id: `ws_${workspace}`, version: 3, kind: "promoted", ...extra });
function setup(data: unknown[]) {
  const get = vi.fn().mockResolvedValue({ body: { data } });
  const notifyWorkspaceRolesOnce = vi.fn().mockResolvedValue(1);
  return { get, notifyWorkspaceRolesOnce, producer: new DeploymentChangedProducer({ get } as unknown as EngineClient, { notifyWorkspaceRolesOnce } as unknown as NotificationService) };
}

describe("DeploymentChangedProducer", () => {
  it("reads a two-hour lookback through the system caller", async () => {
    const { producer, get } = setup([]);
    await producer.produce(context);
    expect(get).toHaveBeenCalledWith("/api/v1/deployment-changes?changed_after=2026-09-29T10%3A00%3A00.000Z", caller);
  });
  it("announces promoted and restored versions to admins and editors with separate dedupe keys", async () => {
    const { producer, notifyWorkspaceRolesOnce } = setup([change(), change({ kind: "restored" })]);
    await expect(producer.produce(context)).resolves.toBe(2);
    const shared = { tenantId, workspaceId: workspace, eventClass: "workflow", severity: "info", title: "A workflow's live version changed", deepLink: "/app/workflows/wf_1", sourceService: "platform-api.engine-events" };
    expect(notifyWorkspaceRolesOnce).toHaveBeenNthCalledWith(1, ["admin", "editor"], "deploy:wfv_1:promoted", { ...shared, body: "Version 3 of this workflow is now live" });
    expect(notifyWorkspaceRolesOnce).toHaveBeenNthCalledWith(2, ["admin", "editor"], "deploy:wfv_1:restored", { ...shared, body: "This workflow was rolled back to version 3" });
  });
  it("uses a stable key for repeated observations", async () => {
    const { producer, notifyWorkspaceRolesOnce } = setup([change(), change()]);
    notifyWorkspaceRolesOnce.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    await expect(producer.produce(context)).resolves.toBe(2);
    expect(notifyWorkspaceRolesOnce.mock.calls.map((call) => call[1])).toEqual(["deploy:wfv_1:promoted", "deploy:wfv_1:promoted"]);
  });
  it("skips malformed records rather than guessing their destination", async () => {
    const { producer, notifyWorkspaceRolesOnce } = setup([change({ workspace_id: null }), change({ workflow_id: "" }), change({ workflow_version_id: null }), change({ kind: "draft" }), change({ version: 0 }), change({ version: 1.5 })]);
    await expect(producer.produce(context)).resolves.toBe(0);
    expect(notifyWorkspaceRolesOnce).not.toHaveBeenCalled();
  });
  it("continues after one notification fails", async () => {
    const { producer, notifyWorkspaceRolesOnce } = setup([change(), change({ workflow_version_id: "wfv_2" })]);
    notifyWorkspaceRolesOnce.mockRejectedValueOnce(new Error("db unavailable")).mockResolvedValueOnce(3);
    await expect(producer.produce(context)).resolves.toBe(3);
  });
  it("lets engine errors reach the runner", async () => {
    const { producer, get } = setup([]);
    get.mockRejectedValueOnce(new Error("engine 503"));
    await expect(producer.produce(context)).rejects.toThrow("engine 503");
  });
  it("is registered in the production runner's producer list", () => {
    const providers = Reflect.getMetadata("providers", EngineEventNotificationModule) as Array<unknown>;
    expect(providers).toContain(DeploymentChangedProducer);
    const registration = providers.find((provider) => typeof provider === "object" && provider !== null && "provide" in provider && provider.provide === ENGINE_EVENT_PRODUCERS) as { inject: unknown[]; useFactory: (...values: unknown[]) => unknown[] };
    expect(registration.inject).toContain(DeploymentChangedProducer);
    const instances = registration.inject.map((provider) => ({ provider }));
    expect(registration.useFactory(...instances)).toContain(instances[registration.inject.indexOf(DeploymentChangedProducer)]);
  });
});
