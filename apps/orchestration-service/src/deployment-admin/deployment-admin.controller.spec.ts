import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DeploymentAdminController } from "./deployment-admin.controller";
import type { DeploymentAdminService } from "./deployment-admin.service";

const TOKEN = "internal-token";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

describe("DeploymentAdminController", () => {
  it("requires dedicated internal bearer token", async () => {
    const service = { apply: vi.fn() } as unknown as DeploymentAdminService;
    const controller = new DeploymentAdminController(service, HASH);
    await expect(controller.apply({}, "Bearer wrong")).rejects.toMatchObject({ status: 401 });
    expect(service.apply).not.toHaveBeenCalled();
  });

  it("validates then forwards authenticated action", async () => {
    const input = {
      tenant_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      deployment_id: "dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",
      action: "suspend" as const,
      reason: "incident",
      staff_user_id:"stf_admin",
    };
    const apply = vi.fn().mockResolvedValue({ status: "suspended" });
    const controller = new DeploymentAdminController({ apply } as unknown as DeploymentAdminService, HASH);
    await expect(controller.apply(input, `Bearer ${TOKEN}`,'"current"')).resolves.toEqual({ status: "suspended" });
    expect(apply).toHaveBeenCalledWith({tenant_id:input.tenant_id,deployment_id:input.deployment_id,action:input.action,reason:input.reason},"stf_admin",'"current"');
  });

  it("rejects malformed action", async () => {
    const controller = new DeploymentAdminController({ apply: vi.fn() } as unknown as DeploymentAdminService, HASH);
    await expect(controller.apply({ action: "delete" }, `Bearer ${TOKEN}`)).rejects.toBeInstanceOf(HttpException);
  });
});
