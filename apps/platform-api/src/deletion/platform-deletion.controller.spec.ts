import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PlatformDeletionController } from "./platform-deletion.controller";
import type { PlatformDeletionService } from "./platform-deletion.service";

const TOKEN = "shared-deletion-token";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const AUTH = `Bearer ${TOKEN}`;

function setup() {
  const service = {
    locateSubjectData: vi.fn().mockResolvedValue([]),
    deleteSubjectData: vi.fn().mockResolvedValue({ store: "platform-api", manifestId: "m", deletedRows: 1, deletedObjects: 0 }),
    verifyDeletion: vi.fn().mockResolvedValue({ store: "platform-api", manifestId: "m", deleted: true, remaining: [] }),
    applyRetentionPolicy: vi.fn().mockResolvedValue({}),
    listSubjectIds: vi.fn().mockResolvedValue([]),
  } as unknown as PlatformDeletionService;
  return { service, controller: new PlatformDeletionController(service, HASH) };
}

describe("PlatformDeletionController", () => {
  it.each([undefined, "", "Bearer wrong", "Basic abc"])("refuses %j on every route and touches nothing", async (auth) => {
    const { controller, service } = setup();
    for (const call of [
      () => controller.locate("ten_x", auth),
      () => controller.delete({ tenantId: "ten_x", manifestId: "del_x" }, auth),
      () => controller.verify({ tenantId: "ten_x", manifestId: "del_x" }, auth),
      () => controller.retention(auth),
      () => controller.subjects(auth),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 401 });
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("relays delete and verify for the shared token", async () => {
    const { controller, service } = setup();
    await controller.delete({ tenantId: "ten_t", manifestId: "del_m" }, AUTH);
    await controller.verify({ tenantId: "ten_t", manifestId: "del_m" }, AUTH);
    expect(service.deleteSubjectData).toHaveBeenCalledWith("ten_t", "del_m");
    expect(service.verifyDeletion).toHaveBeenCalledWith("ten_t", "del_m");
  });

  it("answers 400 for a missing field or a malformed id, and 500 without detail for anything else", async () => {
    const { controller, service } = setup();
    await expect(controller.delete({}, AUTH)).rejects.toMatchObject({ status: 400 });
    (service.locateSubjectData as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("tenantId must be a ten_ prefixed UUIDv7"));
    await expect(controller.locate("bad", AUTH)).rejects.toMatchObject({ status: 400 });
    (service.listSubjectIds as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("relation secret_table missing"));
    const error = (await controller.subjects(AUTH).catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(500);
    expect(JSON.stringify(error.getResponse())).not.toContain("secret_table");
  });
});
