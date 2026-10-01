import type { AuditEventHandler } from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../signup/platform-db";
import { WorkspaceErasureRunner } from "./workspace-erasure.runner";

const TENANT_A = "018f47a5-7b2c-7d10-8f11-0000000000a1";
const TENANT_B = "018f47a5-7b2c-7d10-8f11-0000000000b1";

function harness(options: { failTenant?: string; failErasure?: unknown } = {}) {
  const db = {
    queryTenant: vi.fn(async (tenant: string) => {
      if (tenant === options.failTenant) throw new Error("db down");
      return [{ id: `ws-of-${tenant.slice(-2)}` }];
    }),
  } as unknown as PlatformDb;
  const erasure = {
    executeWorkspaceErasure: vi.fn(async () => {
      if (options.failErasure !== undefined) throw options.failErasure;
      return { manifestId: "del_fixture", completed: true };
    }),
  };
  const audit = { recordEvent: vi.fn(async () => ({})) };
  const runner = new WorkspaceErasureRunner(
    { listActiveTenantIds: async () => [TENANT_A, TENANT_B] },
    db,
    erasure,
    audit as unknown as AuditEventHandler,
  );
  return { runner, erasure, audit };
}

describe("WorkspaceErasureRunner (D2)", () => {
  it("erases each due workspace with prefixed ids and audits it as the system principal", async () => {
    const { runner, erasure, audit } = harness();
    await expect(runner.run(new Date("2026-10-01T00:00:00Z"))).resolves.toEqual({ tenants: 2, tenantsFailed: 0, workspacesErased: 2, workspacesFailed: 0 });
    expect(erasure.executeWorkspaceErasure).toHaveBeenCalledWith(`ten_${TENANT_A}`, "ws_ws-of-a1");
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT_A, actor_type: "system", actor_ref: "system:platform-jobs", action: "workspace.deletion.erase",
      context_json: JSON.stringify({ manifest_id: "del_fixture" }),
    }));
  });

  it("counts a tenant whose due list cannot be read and carries on with the others", async () => {
    const { runner, erasure } = harness({ failTenant: TENANT_A });
    await expect(runner.run()).resolves.toEqual({ tenants: 2, tenantsFailed: 1, workspacesErased: 1, workspacesFailed: 0 });
    expect(erasure.executeWorkspaceErasure).toHaveBeenCalledTimes(1);
  });

  it.each([[new Error("verification failed")], ["not an Error"]])("leaves a failed erasure pending, unaudited (%s)", async (failure) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runner, audit } = harness({ failErasure: failure });
    await expect(runner.run()).resolves.toEqual({ tenants: 2, tenantsFailed: 0, workspacesErased: 0, workspacesFailed: 2 });
    expect(audit.recordEvent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retried"), expect.objectContaining({ error: String(failure instanceof Error ? failure.message : failure) }));
    log.mockRestore();
  });
});
