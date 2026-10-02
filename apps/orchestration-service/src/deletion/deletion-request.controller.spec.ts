import { HttpException } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { ProblemDetailsSchema } from "@alterx/contracts";
import { describe, expect, it, vi } from "vitest";

import { DeletionRequestController } from "./deletion-request.controller";
import type { OrchestrationDeletionService } from "./deletion.service";

const TENANT_A = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890b1";

describe("DeletionRequestController", () => {
  it("deletes then verifies only authenticated actor tenant", async () => {
    const calls: string[] = [];
    const deleteSubjectData = vi.fn(async () => {
      calls.push("delete");
      return { store: "orchestration-service", manifestId: "unused", deletedRows: 2, deletedObjects: 0 };
    });
    const verifyDeletion = vi.fn(async (_tenantId: string, manifestId: string) => {
      calls.push("verify");
      return { store: "orchestration-service", manifestId, deleted: true, remaining: [] };
    });
    const controller = controllerWith({ deleteSubjectData, verifyDeletion });

    const result = await controller.deleteAndVerify(actorRequest(TENANT_A, {
      tenantId: TENANT_B,
      workspaceId: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890b1",
    }));

    expect(calls).toEqual(["delete", "verify"]);
    expect(deleteSubjectData).toHaveBeenCalledWith(TENANT_A, expect.stringMatching(/^del_[0-9a-f-]{36}$/));
    expect(verifyDeletion).toHaveBeenCalledWith(TENANT_A, result.manifestId);
    expect(deleteSubjectData).not.toHaveBeenCalledWith(TENANT_B, expect.anything());
    expect(result).toEqual({
      store: "orchestration-service",
      manifestId: expect.stringMatching(/^del_[0-9a-f-]{36}$/),
      deleted: true,
      remaining: [],
    });
  });

  it("applies retention only to authenticated actor tenant", async () => {
    const applyTenantRetentionPolicy = vi.fn().mockResolvedValue({
      store: "orchestration-service",
      deletedRows: 1,
      deletedObjects: 0,
      sweptAt: "2026-08-04T00:00:00.000Z",
    });
    const controller = controllerWith({ applyTenantRetentionPolicy });

    await controller.retention(actorRequest(TENANT_A, { tenantId: TENANT_B }));

    expect(applyTenantRetentionPolicy).toHaveBeenCalledExactlyOnceWith(TENANT_A);
  });

  it("fails closed without authenticated tenant context", async () => {
    const controller = controllerWith({});

    await expect(controller.deleteAndVerify({ headers: {} }))
      .rejects.toMatchObject({ status: 500 });
  });

  it("maps service failure to RFC 9457 problem details without leaking detail", async () => {
    const controller = controllerWith({
      deleteSubjectData: vi.fn().mockRejectedValue(new Error(`database failed for ${TENANT_A}`)),
    });

    try {
      await controller.deleteAndVerify(actorRequest(TENANT_A));
      throw new Error("expected deletion failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      const response = ProblemDetailsSchema.parse((error as HttpException).getResponse());
      expect(response).toMatchObject({ status: 500, error_code: "DELETION_INTERNAL_ERROR" });
      expect(JSON.stringify(response)).not.toContain(TENANT_A);
    }
  });

  it("maps retention failure without leaking service detail", async () => {
    const controller = controllerWith({
      applyTenantRetentionPolicy: vi.fn().mockRejectedValue(new Error(`retention failed for ${TENANT_A}`)),
    });

    try {
      await controller.retention(actorRequest(TENANT_A));
      throw new Error("expected retention failure");
    } catch (error: unknown) {
      const response = ProblemDetailsSchema.parse((error as HttpException).getResponse());
      expect(response).toMatchObject({ status: 500, error_code: "DELETION_INTERNAL_ERROR" });
      expect(JSON.stringify(response)).not.toContain(TENANT_A);
    }
  });

  it("preserves an existing HTTP exception", async () => {
    const expected = new HttpException("upstream problem", 409);
    const controller = controllerWith({
      deleteSubjectData: vi.fn().mockResolvedValue({}),
      verifyDeletion: vi.fn().mockRejectedValue(expected),
    });

    await expect(controller.deleteAndVerify(actorRequest(TENANT_A))).rejects.toBe(expected);
  });

  it("uses normal Session Gateway protection", () => {
    expect(Reflect.getMetadata("path", DeletionRequestController)).toBe("api/v1/deletion-requests");
    expect(Reflect.getMetadata("isPublic", DeletionRequestController)).not.toBe(true);
  });
});

function actorRequest(
  tenantId: string,
  untrustedBody?: Record<string, unknown>,
): IdentityTenantGatewayRequest & { readonly body?: Record<string, unknown> } {
  return {
    url: "/api/v1/deletion-requests",
    headers: {},
    actorContext: {
      actor_type: "user",
      user_id: "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",
      tenant_id: tenantId,
      workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890a3",
      roles: ["owner"],
      permissions: ["knowledge:admin"],
      session_id: "session-a",
      jti: "jti-a",
    },
    ...(untrustedBody === undefined ? {} : { body: untrustedBody }),
  };
}

function controllerWith(methods: Partial<OrchestrationDeletionService>): DeletionRequestController {
  return new DeletionRequestController(methods as OrchestrationDeletionService);
}
