import { describe, expect, it, vi } from "vitest";
import { staffRolesMetadataKey } from "../rbac/rbac.metadata";
import { AdminDeploymentController } from "./admin-deployment.controller";
import { AdminDeploymentService } from "./admin-deployment.service";

const INPUT = {
  tenant_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  deployment_id: "dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",
  action: "suspend" as const,
  reason: "provider incident",
};


describe("admin deployment plane", () => {
  it("allows only staff_admin role on mutation route", () => {
    expect(Reflect.getMetadata(staffRolesMetadataKey, AdminDeploymentController.prototype.apply))
      .toEqual(["staff_admin"]);
  });


  it("requires matching route and body deployment IDs", async () => {
    const service = { apply: vi.fn() } as unknown as AdminDeploymentService;
    const controller = new AdminDeploymentController(service);
    expect(() => controller.apply("dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a1", INPUT, {
      staffActorContext: { staff_user_id: "stf_admin" },
    } as never, undefined,undefined)).toThrow(expect.objectContaining({
      response: expect.objectContaining({ detail: "Body deployment_id must match route deploymentId" }),
    }));
    expect(service.apply).not.toHaveBeenCalled();
  });
});
