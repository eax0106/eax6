import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../rbac/types";
import { PlatformHttpError } from "../signup/problem";
import { MembersController } from "./members.controller";
import type { WorkspaceInvitationsService } from "./workspace-invitations.service";
import type { MembersService } from "./members.service";

const actor: ActorContext = {
  user_id: "user",
  tenant_id: "tenant",
  roles: ["owner"],
  permissions: [],
  session_id: "session",
};

describe("MembersController", () => {
  it("forwards list, invite, and removal scopes", async () => {
    const list = vi.fn().mockResolvedValue([{ id: "member" }]);
    const invite = vi.fn().mockResolvedValue({ id: "member" });
    const remove = vi.fn().mockResolvedValue(undefined);
    const controller = new MembersController({ list, invite, remove } as unknown as MembersService, {} as WorkspaceInvitationsService);
    await expect(controller.list(actor)).resolves.toEqual([{ id: "member" }]);
    await controller.invite(actor, { email: "new@company.test", role: "viewer", workspaceId: "workspace" });
    await controller.remove(actor, "member", "workspace");
    await controller.remove(actor, "member");
    expect(remove).toHaveBeenNthCalledWith(1, actor, "member", "workspace", undefined);
    expect(remove).toHaveBeenNthCalledWith(2, actor, "member", "workspace", undefined);
  });

  it("rejects missing actor", () => {
    expect(() => new MembersController({} as MembersService, {} as WorkspaceInvitationsService).list(undefined)).toThrow(
      PlatformHttpError,
    );
  });
});
