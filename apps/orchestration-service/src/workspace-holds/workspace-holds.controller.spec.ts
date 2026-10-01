import { describe, expect, it, vi } from "vitest";

import { WorkspaceHoldsController } from "./workspace-holds.controller";
import type { WorkspaceHoldsService } from "./workspace-holds.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const WS = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f1";

function request(overrides: Record<string, unknown> = {}) {
  return {
    url: `/api/v1/workspace-holds/${WS}`,
    actorContext: { actor_type: "user", user_id: "usr_1", tenant_id: TENANT, workspace_id: null, roles: ["admin"], permissions: [], session_id: "s", jti: "j", ...overrides },
  } as never;
}

function service() {
  return { hold: vi.fn(async () => undefined), release: vi.fn(async () => undefined) } as unknown as WorkspaceHoldsService & Record<string, ReturnType<typeof vi.fn>>;
}

describe("WorkspaceHoldsController (D2)", () => {
  it("holds and releases for a tenant owner or admin", async () => {
    const holds = service();
    await new WorkspaceHoldsController(holds).hold(request(), WS);
    await new WorkspaceHoldsController(holds).release(request({ roles: ["owner"] }), WS);
    expect(holds.hold).toHaveBeenCalledWith(TENANT, WS, "usr_1");
    expect(holds.release).toHaveBeenCalledWith(TENANT, WS);
  });

  it.each([
    ["an editor", { roles: ["editor"] }],
    ["a system principal", { actor_type: "system", user_id: null, roles: [] }],
    ["a service actor", { actor_type: "service", roles: ["admin"] }],
  ])("refuses %s", async (_name, overrides) => {
    const holds = service();
    await expect(new WorkspaceHoldsController(holds).hold(request(overrides), WS)).rejects.toMatchObject({ status: 403 });
    expect(holds.hold).not.toHaveBeenCalled();
  });
});
