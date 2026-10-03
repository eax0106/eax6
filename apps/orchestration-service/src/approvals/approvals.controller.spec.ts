import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ApprovalsController } from "./approvals.controller";
import {
  ApprovalNotFoundError,
  ApprovalsService,
  ApprovalStateConflictError,
  ApprovalValidationError,
} from "./approvals.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const APPROVAL = "apr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const USER_ID = "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

function approvals(): ApprovalsService {
  return {
    createPending: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    decide: vi.fn(),
  } as unknown as ApprovalsService;
}

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL,
    run_id: RUN,
    node_execution_id: NODE_EXECUTION,
    requested_action: { message: "send invoice" },
    status: "pending",
    requested_at: "2026-07-28T00:00:00.000Z",
    decided_at: null,
    decided_by: null,
    decision_note: null,
    expiry_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function request(tenantId: string | undefined = TENANT, userId: string | null = USER_ID) {
  return {
    actorContext: tenantId === undefined ? undefined : { tenant_id: tenantId, user_id: userId, workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac" },
    url: "/api/v1/approvals",
  };
}

describe("ApprovalsController.list/get", () => {
  it("lists approvals tenant-scoped with query filters", async () => {
    const service = approvals();
    vi.mocked(service.list).mockResolvedValue({
      data: [approvalRow()],
      page: { next_cursor: null, has_more: false, limit: 50 },
    });

    const response = await new ApprovalsController(service).list(request() as never, {
      status: "pending",
    });

    expect(service.list).toHaveBeenCalledWith(TENANT, { status: "pending", workspaceId: "018f4d6e-2b4a-7a3e-8c1a-1234567890ac" });
    expect(response.data).toHaveLength(1);
  });

  it("maps ApprovalNotFoundError to 404 on get", async () => {
    const service = approvals();
    vi.mocked(service.getById).mockRejectedValue(new ApprovalNotFoundError(APPROVAL));

    await expect(
      new ApprovalsController(service).get(request() as never, APPROVAL),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 404 }) });
  });

  it("returns 500 with real ProblemDetails identifiers when tenant context is missing", async () => {
    await expect(
      new ApprovalsController(approvals()).get(request(undefined) as never, APPROVAL),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        status: 500,
        trace_id: expect.stringMatching(/^trc_[0-9a-f-]+$/i),
        request_id: expect.stringMatching(/^req_[0-9a-f-]+$/i),
      }),
    });
  });
});

describe("ApprovalsController.approve/reject", () => {
  it("approves and strips the usr_ prefix from decided_by", async () => {
    const service = approvals();
    vi.mocked(service.decide).mockResolvedValue(approvalRow({ status: "approved" }));

    const response = await new ApprovalsController(service).approve(
      request() as never,
      APPROVAL,
      { note: "looks good" },
    );

    expect(service.decide).toHaveBeenCalledWith(
      TENANT,
      APPROVAL,
      "approved",
      "018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      "looks good",
    );
    expect(response).toMatchObject({ status: "approved" });
  });

  it("rejects with the same decide() path and decision=rejected", async () => {
    const service = approvals();
    vi.mocked(service.decide).mockResolvedValue(approvalRow({ status: "rejected" }));

    await new ApprovalsController(service).reject(request() as never, APPROVAL, {});

    expect(service.decide).toHaveBeenCalledWith(
      TENANT,
      APPROVAL,
      "rejected",
      "018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      undefined,
    );
  });

  it("passes undefined decided_by for a service actor with no user_id", async () => {
    const service = approvals();
    vi.mocked(service.decide).mockResolvedValue(approvalRow({ status: "approved" }));

    await new ApprovalsController(service).approve(request(TENANT, null) as never, APPROVAL, {});

    expect(service.decide).toHaveBeenCalledWith(TENANT, APPROVAL, "approved", undefined, undefined);
  });

  it("maps ApprovalStateConflictError to 409", async () => {
    const service = approvals();
    vi.mocked(service.decide).mockRejectedValue(
      new ApprovalStateConflictError("already decided"),
    );

    await expect(
      new ApprovalsController(service).approve(request() as never, APPROVAL, {}),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 409 }) });
  });

  it("maps ApprovalValidationError to 400", async () => {
    const service = approvals();
    vi.mocked(service.decide).mockRejectedValue(new ApprovalValidationError("bad id"));

    await expect(
      new ApprovalsController(service).approve(request() as never, APPROVAL, {}),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 400 }) });
  });

  it("maps an unknown error to 500", async () => {
    const service = approvals();
    vi.mocked(service.decide).mockRejectedValue(new Error("unexpected"));

    await expect(
      new ApprovalsController(service).approve(request() as never, APPROVAL, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
