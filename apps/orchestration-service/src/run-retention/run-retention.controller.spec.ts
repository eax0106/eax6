import { describe, expect, it, vi } from "vitest";

import { RunRetentionController } from "./run-retention.controller";
import { RunRetentionConfirmationRequiredError, type RunRetentionService } from "./run-retention.service";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const WS = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";

function request(overrides: Record<string, unknown> = {}) {
  return {
    url: "/api/v1/run-retention",
    actorContext: {
      actor_type: "user", user_id: "usr_1", tenant_id: TENANT, workspace_id: WS,
      roles: ["admin"], permissions: ["runs:retention:write"], session_id: "s", jti: "j", ...overrides,
    },
  } as never;
}
const reply = () => ({ header: vi.fn() }) as never;
const setting = { retentionDays: 30, isDefault: false, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: "usr_1", etag: '"e"' };

describe("RunRetentionController (D2)", () => {
  it("sets with If-Match and the confirmation flag from the caller's workspace", async () => {
    const set = vi.fn(async () => setting);
    const controller = new RunRetentionController({ set } as unknown as RunRetentionService);
    await expect(controller.set(request(), { retention_days: 30, confirm_lowering: true }, reply(), '"e"'))
      .resolves.toMatchObject({ retention_days: 30, etag: '"e"' });
    expect(set).toHaveBeenCalledWith(TENANT, WS, { retentionDays: 30, confirmLowering: true, updatedBy: "usr_1" }, '"e"');
  });

  it("requires If-Match, the write grant, a person, and a strict body", async () => {
    const set = vi.fn(async () => setting);
    const controller = new RunRetentionController({ set } as unknown as RunRetentionService);
    await expect(controller.set(request(), { retention_days: 30 }, reply(), undefined)).rejects.toMatchObject({ status: 428 });
    await expect(controller.set(request({ permissions: [] }), { retention_days: 30 }, reply(), '"e"')).rejects.toMatchObject({ status: 403 });
    await expect(controller.set(request({ actor_type: "system", user_id: null }), { retention_days: 30 }, reply(), '"e"')).rejects.toMatchObject({ status: 403 });
    await expect(controller.set(request(), { retention_days: 30, extra: 1 }, reply(), '"e"')).rejects.toMatchObject({ status: 400 });
    await expect(controller.set(request(), { retention_days: "30" }, reply(), '"e"')).rejects.toMatchObject({ status: 400 });
    expect(set).not.toHaveBeenCalled();
  });

  it("answers 409 with the count when a lowering is unconfirmed", async () => {
    const set = vi.fn(async () => { throw new RunRetentionConfirmationRequiredError(12); });
    const controller = new RunRetentionController({ set } as unknown as RunRetentionService);
    const error = await controller.set(request(), { retention_days: 7 }, reply(), '"e"').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409 });
    expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({ error_code: "RUN_RETENTION_CONFIRM_REQUIRED", runs_to_delete: 12 });
  });
});
