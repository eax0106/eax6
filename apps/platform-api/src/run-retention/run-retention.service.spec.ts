import "reflect-metadata";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";
import { EngineProblemError, type EngineClient } from "../engine";
import { permissionsForRoles } from "../rbac/permissions";
import { permissionsMetadataKey, workspaceRolesMetadataKey } from "../rbac/rbac.metadata";
import { RunRetentionRelayController } from "./run-retention.controller";
import type { ActorContext } from "../rbac/types";
import { RunRetentionRelayService } from "./run-retention.service";

const actor: ActorContext = {
  user_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890a1",
  tenant_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890b1",
  workspace_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890c1",
  roles: ["admin"],
  permissions: permissionsForRoles(["admin"]),
  session_id: "session",
};
const view = (days: number, etag: string) => ({ retention_days: days, is_default: false, updated_at: null, updated_by: null, etag });

function harness() {
  const engine = {
    get: vi.fn(async () => ({ status: 200, body: view(90, '"before"') })),
    put: vi.fn(async () => ({ status: 200, body: view(30, '"after"') })),
  };
  const audit = { recordEvent: vi.fn(async () => ({})) };
  const service = new RunRetentionRelayService(engine as unknown as EngineClient, audit as unknown as AuditEventHandler);
  return { engine, audit, service };
}

describe("RunRetentionRelayService relay (D2)", () => {
  it("grants runs:retention:write to workspace admins only", () => {
    expect(permissionsForRoles(["admin"])).toContain("runs:retention:write");
    for (const role of ["editor", "operator", "approver", "viewer", "member", "billing"]) {
      expect(permissionsForRoles([role])).not.toContain("runs:retention:write");
    }
  });

  it("lets only a workspace admin with the grant preview or change it", () => {
    for (const method of ["preview", "set"] as const) {
      expect(Reflect.getMetadata(workspaceRolesMetadataKey, RunRetentionRelayController.prototype[method])).toEqual(["admin"]);
      expect(Reflect.getMetadata(permissionsMetadataKey, RunRetentionRelayController.prototype[method])).toEqual(["runs:retention:write"]);
    }
  });

  it("relays a change with If-Match and audits before and after", async () => {
    const { engine, audit, service } = harness();
    await expect(service.set(actor, { retention_days: 30, confirm_lowering: true }, '"before"', undefined)).resolves.toMatchObject({ retention_days: 30 });
    expect(engine.put).toHaveBeenCalledWith(
      "/api/v1/run-retention",
      { retention_days: 30, confirm_lowering: true },
      expect.objectContaining({ workspaceId: actor.workspace_id, userId: actor.user_id }),
      expect.objectContaining({ ifMatch: '"before"' }),
    );
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.run_retention.update",
      target_ref: actor.workspace_id,
      context_json: JSON.stringify({ before_days: 90, after_days: 30 }),
    }));
  });

  it("requires If-Match, and records nothing when the engine refuses", async () => {
    const { engine, audit, service } = harness();
    await expect(service.set(actor, { retention_days: 30 }, undefined, undefined)).rejects.toMatchObject({ status: 428 });
    engine.put.mockRejectedValueOnce(new EngineProblemError({
      type: "https://alter.dev/problems/run-retention-confirm-required", title: "Conflict", status: 409,
      detail: "Lowering run-history retention deletes 4 runs; confirm to continue", instance: "/api/v1/run-retention",
    } as never));
    await expect(service.set(actor, { retention_days: 7 }, '"before"', undefined)).rejects.toMatchObject({ status: 409 });
    expect(audit.recordEvent).not.toHaveBeenCalled();
  });

  it("previews only a whole number of days", async () => {
    const { engine, service } = harness();
    engine.get.mockResolvedValueOnce({ status: 200, body: { retention_days: 30, runs_to_delete: 4 } as never });
    await expect(service.preview(actor, "30", undefined)).resolves.toEqual({ retention_days: 30, runs_to_delete: 4 });
    expect(engine.get).toHaveBeenCalledWith("/api/v1/run-retention/preview?retention_days=30", expect.anything());
    for (const bad of [undefined, "abc", "30&x=1", "1000"]) {
      await expect(service.preview(actor, bad, undefined)).rejects.toMatchObject({ status: 400 });
    }
  });
});
