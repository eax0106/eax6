import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { tenantRolesMetadataKey } from "../rbac/rbac.metadata";
import type { ActorContext } from "../rbac/types";
import { PlatformHttpError } from "../signup/problem";
import { WorkspacesController } from "./workspaces.controller";
import type { WorkspaceDeletionService } from "./workspace-deletion.service";
import type { WorkspaceSafeguardsService } from "./workspace-safeguards.service";
import type { WorkspacesService } from "./workspaces.service";

const actor: ActorContext = {
  user_id: "user",
  tenant_id: "tenant",
  roles: ["owner"],
  permissions: [],
  session_id: "session",
};
const workspace = {
  id: "workspace",
  tenantId: "tenant",
  name: "Default",
  status: "active",
  updatedAt: new Date("2026-07-23T00:00:00.000Z"),
};

const noSafeguards = {} as WorkspaceSafeguardsService;

function reply() {
  const send = vi.fn();
  const header = vi.fn(() => ({ send }));
  return { value: { header } as unknown as FastifyReply, header, send };
}

const noDeletion = {} as WorkspaceDeletionService;

describe("WorkspacesController", () => {
  it("forwards list and create including default name", async () => {
    const list = vi.fn().mockResolvedValue([workspace]);
    const create = vi.fn().mockResolvedValue(workspace);
    const controller = new WorkspacesController({ list, create } as unknown as WorkspacesService, noSafeguards, noDeletion);
    await expect(controller.list(actor)).resolves.toEqual([workspace]);
    await controller.create(actor, { name: "New" });
    await controller.create(actor, {});
    expect(create).toHaveBeenNthCalledWith(1, actor, "New");
    expect(create).toHaveBeenNthCalledWith(2, actor, "");
  });

  it("writes ETags for get and update", async () => {
    const get = vi.fn().mockResolvedValue(workspace);
    const update = vi.fn().mockResolvedValue({ ...workspace, name: "Renamed" });
    const controller = new WorkspacesController({ get, update } as unknown as WorkspacesService, noSafeguards, noDeletion);
    const getReply = reply();
    await controller.get(actor, "workspace", getReply.value);
    expect(getReply.header).toHaveBeenCalledWith("ETag", expect.stringMatching(/^".+"$/));
    expect(getReply.send).toHaveBeenCalledWith(workspace);

    const updateReply = reply();
    await controller.update(actor, "workspace", '"etag"', {}, updateReply.value);
    expect(update).toHaveBeenCalledWith(actor, "workspace", "", '"etag"');
    expect(updateReply.send).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed" }));
  });

  it("forwards safeguard reads and owner-only writes with the If-Match header", async () => {
    const view = { safeguards: { contains_pii: true, approve_external_actions: true } };
    const get = vi.fn().mockResolvedValue(view);
    const set = vi.fn().mockResolvedValue(view);
    const controller = new WorkspacesController(
      {} as WorkspacesService,
      { get, set } as unknown as WorkspaceSafeguardsService,
      noDeletion,
    );

    await expect(controller.getSafeguards(actor, "workspace")).resolves.toEqual(view);
    await controller.setSafeguards(actor, "workspace", view, '"etag"');

    expect(get).toHaveBeenCalledWith(actor, "workspace");
    expect(set).toHaveBeenCalledWith(actor, "workspace", view, '"etag"');
    expect(Reflect.getMetadata(tenantRolesMetadataKey, WorkspacesController)).toEqual(["member"]);
    expect(
      Reflect.getMetadata(tenantRolesMetadataKey, WorkspacesController.prototype.setSafeguards),
    ).toEqual(["owner"]);
  });

  it("forwards deletion with the typed name, restore and the pending list, admin-only (D2)", async () => {
    const requestDeletion = vi.fn().mockResolvedValue({ status: "pending_deletion" });
    const restore = vi.fn().mockResolvedValue({ status: "active" });
    const listPendingDeletion = vi.fn().mockResolvedValue([]);
    const controller = new WorkspacesController(
      { listPendingDeletion } as unknown as WorkspacesService,
      noSafeguards,
      { requestDeletion, restore } as unknown as WorkspaceDeletionService,
    );

    await controller.requestDeletion(actor, "workspace", { confirm_name: "Name" });
    await controller.requestDeletion(actor, "workspace", undefined);
    await controller.restore(actor, "workspace");
    await controller.listPendingDeletion(actor);

    expect(requestDeletion).toHaveBeenNthCalledWith(1, actor, "workspace", "Name");
    expect(requestDeletion).toHaveBeenNthCalledWith(2, actor, "workspace", undefined);
    expect(restore).toHaveBeenCalledWith(actor, "workspace");
    expect(listPendingDeletion).toHaveBeenCalledWith(actor);
    for (const method of ["requestDeletion", "restore", "listPendingDeletion"] as const) {
      expect(Reflect.getMetadata(tenantRolesMetadataKey, WorkspacesController.prototype[method])).toEqual(["admin"]);
    }
  });

  it("rejects missing actor", () => {
    expect(() => new WorkspacesController({} as WorkspacesService, noSafeguards, noDeletion).list()).toThrow(
      PlatformHttpError,
    );
  });
});
