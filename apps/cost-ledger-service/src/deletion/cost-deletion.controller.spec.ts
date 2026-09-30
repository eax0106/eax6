import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CostDeletionController } from "./cost-deletion.controller";
import type { CostDeletionService } from "./cost-deletion.service";

const TOKEN = "shared-token";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function setup() {
  const service = {
    locateSubjectData: vi.fn().mockResolvedValue([]),
    deleteSubjectData: vi.fn().mockResolvedValue({}),
    verifyDeletion: vi.fn().mockResolvedValue({}),
    applyRetentionPolicy: vi.fn().mockResolvedValue({}),
    listSubjectIds: vi.fn().mockResolvedValue([]),
  } as unknown as CostDeletionService;
  return { service, controller: new CostDeletionController(service, HASH) };
}

describe("CostDeletionController", () => {
  it.each([undefined, "", "Bearer x", "Basic abc"])("refuses %j everywhere and reads nothing", async (auth) => {
    const { controller, service } = setup();
    for (const call of [
      () => controller.locate("ten_x", auth),
      () => controller.delete({ tenantId: "ten_x", manifestId: "del_x" }, auth),
      () => controller.verify({ tenantId: "ten_x", manifestId: "del_x" }, auth),
      () => controller.retention(auth),
      () => controller.subjects(auth),
    ]) {
      expect(call).toThrow("Deletion credential is invalid.");
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("relays for the shared token; a missing field is 400; other failures are 500 with no detail", async () => {
    const { controller, service } = setup();
    await controller.delete({ tenantId: "ten_t", manifestId: "del_m" }, `Bearer ${TOKEN}`);
    expect(service.deleteSubjectData).toHaveBeenCalledWith("ten_t", "del_m");
    await expect(controller.delete({}, `Bearer ${TOKEN}`)).rejects.toMatchObject({ status: 400 });
    (service.listSubjectIds as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("relation secret_x missing"));
    const error = await controller.subjects(`Bearer ${TOKEN}`).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ status: 500 });
    expect(JSON.stringify(error)).not.toContain("secret_x");
  });
});
