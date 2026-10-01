import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceErasureTriggerController } from "./workspace-erasure-trigger.controller";
import type { WorkspaceErasureRunner } from "./workspace-erasure.runner";

const TOKEN = "platform-jobs-token";
const hash = createHash("sha256").update(TOKEN).digest("hex");

describe("WorkspaceErasureTriggerController (D2)", () => {
  it("runs the sweep for the Platform Jobs credential and reports its counts", async () => {
    const run = vi.fn(async () => ({ tenants: 3, tenantsFailed: 1, workspacesErased: 2, workspacesFailed: 1 }));
    const controller = new WorkspaceErasureTriggerController({ run } as unknown as WorkspaceErasureRunner, hash);
    await expect(controller.processDue(`Bearer ${TOKEN}`)).resolves.toEqual({
      tenants: 3, tenants_failed: 1, workspaces_erased: 2, workspaces_failed: 1,
    });
  });

  it.each([undefined, "", "Bearer wrong-token", TOKEN])("refuses %s with 401 and runs nothing", async (header) => {
    const run = vi.fn();
    const controller = new WorkspaceErasureTriggerController({ run } as unknown as WorkspaceErasureRunner, hash);
    await expect(controller.processDue(header)).rejects.toMatchObject({ status: 401 });
    expect(run).not.toHaveBeenCalled();
  });
});
