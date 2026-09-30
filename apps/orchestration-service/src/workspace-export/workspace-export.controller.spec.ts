import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import { ExecutionRuntimeModule } from "../execution-runtime.module";
import { EngineWorkspaceExportController } from "./workspace-export.controller";
import { EngineWorkspaceExportService, EngineWorkspaceExportValidationError } from "./workspace-export.service";

const request = (actorType: string, permissions = ["workflows:read", "runs:read"]) => ({
  url: "/api/v1/workspace-export-metadata",
  actorContext: { actor_type: actorType, tenant_id: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1", permissions },
}) as never;
describe("Engine workspace export controller", () => {
  it("registers the read controller and real store factory in the production module", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ExecutionRuntimeModule)).toContain(EngineWorkspaceExportController);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ExecutionRuntimeModule) as Array<{ provide?: unknown; useFactory?: unknown }>;
    expect(providers.find((provider) => provider.provide === EngineWorkspaceExportService)?.useFactory).toBeTypeOf("function");
  });
  it("delegates only the authenticated system tenant", async () => {
    const page = vi.fn().mockResolvedValue({ data: [], page: { has_more: false } });
    const query = { workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f1", collection: "runs" };
    await new EngineWorkspaceExportController({ page } as unknown as EngineWorkspaceExportService).page(request("system"), query);
    expect(page).toHaveBeenCalledWith("ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1", query);
  });
  it.each(["user", "service"])("rejects %s before reading", async (kind) => {
    const page = vi.fn();
    await expect(new EngineWorkspaceExportController({ page } as unknown as EngineWorkspaceExportService).page(request(kind), {})).rejects.toMatchObject({ status: 403 });
    expect(page).not.toHaveBeenCalled();
  });
  it("requires both workflow and run read permission", async () => {
    const page = vi.fn();
    await expect(new EngineWorkspaceExportController({ page } as unknown as EngineWorkspaceExportService).page(request("system", ["workflows:read"]), {})).rejects.toMatchObject({ status: 403 });
    expect(page).not.toHaveBeenCalled();
  });
  it("rejects missing context and maps errors without returning store details", async () => {
    const page = vi.fn().mockRejectedValueOnce(new EngineWorkspaceExportValidationError("Invalid query")).mockRejectedValueOnce(new Error("private store detail"));
    const controller = new EngineWorkspaceExportController({ page } as unknown as EngineWorkspaceExportService);
    await expect(controller.page({ url: "/" } as never, {})).rejects.toMatchObject({ status: 500 });
    await expect(controller.page(request("system"), {})).rejects.toMatchObject({ status: 400 });
    await expect(controller.page(request("system"), {})).rejects.toMatchObject({ status: 500, response: { detail: "Workspace metadata could not be read" } });
  });
});
