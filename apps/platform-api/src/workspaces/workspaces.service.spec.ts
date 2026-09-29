import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { WorkspacesService, workspaceEtag } from "./workspaces.service";

const actor: ActorContext = {
  user_id: "user",
  tenant_id: "tenant",
  roles: ["owner"],
  permissions: [],
  session_id: "session",
};
const workspace = {
  id: "018f47a5-7b2c-7d10-8f11-123456789abc",
  tenantId: "tenant",
  name: "Default",
  status: "active",
  updatedAt: new Date("2026-07-22T00:00:00.000Z"),
};

describe("WorkspacesService", () => {
  it("enforces If-Match and updates matching version", async () => {
    const queryTenant = vi
      .fn()
      .mockResolvedValueOnce([workspace])
      .mockResolvedValueOnce([{ ...workspace, name: "Renamed" }]);
    const service = new WorkspacesService({ queryTenant } as unknown as PlatformDb);
    await expect(
      service.update(actor, workspace.id, "Renamed", workspaceEtag(workspace)),
    ).resolves.toMatchObject({ name: "Renamed" });

    const mismatchService = new WorkspacesService({
      queryTenant: vi.fn().mockResolvedValue([workspace]),
    } as unknown as PlatformDb);
    await expect(
      mismatchService.update(actor, workspace.id, "Renamed", '"old"'),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      mismatchService.update(actor, workspace.id, "Renamed", undefined),
    ).rejects.toMatchObject({ status: 428 });
  });

  it("lists, creates, and reads workspaces", async () => {
    const queryTenant = vi.fn().mockResolvedValue([workspace]);
    const service = new WorkspacesService({ queryTenant } as unknown as PlatformDb);
    await expect(service.list(actor)).resolves.toEqual([workspace]);
    await expect(service.create(actor, " New ")).resolves.toEqual(workspace);
    await expect(service.get(actor, workspace.id)).resolves.toEqual(workspace);
    expect(queryTenant).toHaveBeenCalledTimes(3);
  });

  it("rejects empty name and missing workspace", async () => {
    const service = new WorkspacesService({
      queryTenant: vi.fn().mockResolvedValue([]),
    } as unknown as PlatformDb);
    await expect(service.create(actor, " ")).rejects.toMatchObject({ status: 400 });
    await expect(service.get(actor, "missing")).rejects.toMatchObject({ status: 404 });
  });

  it("detects concurrent update after initial ETag check", async () => {
    const queryTenant = vi
      .fn()
      .mockResolvedValueOnce([workspace])
      .mockResolvedValueOnce([]);
    const service = new WorkspacesService({ queryTenant } as unknown as PlatformDb);
    await expect(
      service.update(actor, workspace.id, "Renamed", workspaceEtag(workspace)),
    ).rejects.toMatchObject({ status: 412 });
  });
});
