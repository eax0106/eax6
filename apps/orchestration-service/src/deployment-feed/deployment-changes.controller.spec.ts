import { describe, expect, it, vi } from "vitest";
import { DeploymentChangesController } from "./deployment-changes.controller";
import { DeploymentChangesValidationError, type DeploymentChangesService } from "./deployment-changes.service";

const request = (actorType: string) => ({ url: "/api/v1/deployment-changes", actorContext: { actor_type: actorType, tenant_id: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1", workspace_id: null } }) as never;
describe("DeploymentChangesController", () => {
  it("serves the system caller with prefixed workspace IDs", async () => {
    const since = vi.fn().mockResolvedValue([{ workflow_id: "wf_a", workflow_version_id: "wfv_a", version: 2, workspace_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890f1", kind: "restored", changed_at: "2026-09-29T10:00:00.000Z" }]);
    const result = await new DeploymentChangesController({ since } as unknown as DeploymentChangesService).list(request("system"), "2026-09-29T09:00:00Z");
    expect(result.data[0]?.workspace_id).toBe("ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f1");
    expect(since).toHaveBeenCalledWith("ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1", "2026-09-29T09:00:00Z");
  });
  it.each(["user", "service"])("denies %s actors", async (actorType) => {
    const since = vi.fn();
    await expect(new DeploymentChangesController({ since } as unknown as DeploymentChangesService).list(request(actorType), "2026-09-29T09:00:00Z")).rejects.toMatchObject({ status: 403 });
    expect(since).not.toHaveBeenCalled();
  });
  it("rejects missing timestamps before querying", async () => {
    const since = vi.fn();
    await expect(new DeploymentChangesController({ since } as unknown as DeploymentChangesService).list(request("system"))).rejects.toMatchObject({ status: 400 });
    expect(since).not.toHaveBeenCalled();
  });
  it("maps invalid timestamps to 400 and unexpected store errors to 500", async () => {
    const since = vi.fn().mockRejectedValueOnce(new DeploymentChangesValidationError("invalid time")).mockRejectedValueOnce(new Error("db down"));
    const controller = new DeploymentChangesController({ since } as unknown as DeploymentChangesService);
    await expect(controller.list(request("system"), "bad")).rejects.toMatchObject({ status: 400 });
    await expect(controller.list(request("system"), "2026-09-29T09:00:00Z")).rejects.toMatchObject({ status: 500 });
  });
});
