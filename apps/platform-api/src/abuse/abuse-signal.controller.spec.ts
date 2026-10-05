import { describe, expect, it, vi } from "vitest";
import type { RbacRequest } from "../rbac/types";
import { AbuseSignalController } from "./abuse-signal.controller";
import { AbuseSignalExceptionFilter } from "./abuse-signal-exception.filter";
import { AbuseSignalService } from "./abuse-signal.service";
import { AbuseSignalsHttpError } from "./problem";

const id = "abs_018f47a5-7b2c-7d10-8f11-123456789abc";
const request = {
  staffActorContext: { staff_user_id: "stf_security" },
} as RbacRequest;

describe("AbuseSignalController", () => {
  it("validates signal status and authenticates staff actions", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const refresh = vi.fn().mockResolvedValue({ observed: 2, stored: 1 });
    const review = vi.fn().mockResolvedValue({ id, status: "confirmed" });
    const controller = new AbuseSignalController({ list, refresh, review } as unknown as AbuseSignalService);

    await expect(controller.list()).resolves.toEqual([]);
    await expect(controller.list("open")).resolves.toEqual([]);
    expect(() => controller.list("closed")).toThrow(AbuseSignalsHttpError);
    await expect(controller.refresh(request)).resolves.toEqual({ observed: 2, stored: 1 });
    expect(() => controller.refresh({} as RbacRequest)).toThrow(AbuseSignalsHttpError);
    await expect(controller.review(id, { decision: "confirm", reason: "verified evidence" }, request))
      .resolves.toMatchObject({ id, status: "confirmed" });
    expect(() => controller.review("bad", { decision: "confirm", reason: "verified evidence" }, request))
      .toThrow(AbuseSignalsHttpError);
    expect(() => controller.review(id, { decision: "other" }, request))
      .toThrow(AbuseSignalsHttpError);
    expect(() => controller.review(id, { decision: "dismiss", reason: "handled" }, {} as RbacRequest))
      .toThrow(AbuseSignalsHttpError);
    expect(list).toHaveBeenNthCalledWith(1, undefined);
    expect(list).toHaveBeenNthCalledWith(2, "open");
    expect(refresh).toHaveBeenCalledWith("stf_security");
    expect(review).toHaveBeenCalledWith(id, "stf_security", {
      decision: "confirm",
      reason: "verified evidence",
    }, undefined);
  });
});

describe("abuse problem responses", () => {
  it("emits problem details and applies the request URL in the filter", () => {
    const problem = new AbuseSignalsHttpError(503, "ABUSE_SIGNAL_SOURCES_UNAVAILABLE", "sources down", "/original");
    const reply = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: "/actual" }),
        getResponse: () => reply,
      }),
    };

    new AbuseSignalExceptionFilter().catch(problem, host as never);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.type).toHaveBeenCalledWith("application/problem+json");
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      error_code: "ABUSE_SIGNAL_SOURCES_UNAVAILABLE",
      instance: "/actual",
      retryable: true,
      documentation_key: "abuse.signal.sources.unavailable",
    }));
    expect(new AbuseSignalsHttpError(400, "BAD_INPUT", "bad", "/input").getResponse())
      .toMatchObject({ retryable: false, documentation_key: "bad.input" });
  });
});
