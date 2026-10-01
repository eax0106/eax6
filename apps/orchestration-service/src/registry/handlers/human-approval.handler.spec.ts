import { describe, expect, it, vi } from "vitest";

import { NodeHandlerValidationError } from "../handler";
import { HumanApprovalHandler, type ApprovalRequester } from "./human-approval.handler";

const TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION_ID = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

function fakeApprovals(): ApprovalRequester {
  return {
    requestApproval: vi.fn().mockResolvedValue({
      approvalId: "apr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      expiryAt: "2026-07-30T00:00:00.000Z",
    }),
  };
}

describe("HumanApprovalHandler", () => {
  it("persists a pending approval and returns immediately without blocking", async () => {
    const approvals = fakeApprovals();
    const handler = new HumanApprovalHandler(approvals);

    const result = await handler.execute({
      config: { requested_action: { message: "send invoice" } },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(approvals.requestApproval).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      nodeExecutionId: NODE_EXECUTION_ID,
      requestedAction: { message: "send invoice" },
      expirySeconds: 86_400,
    });
    expect(result).toEqual({
      output: {
        approval_id: "apr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        status: "pending",
        expiry_at: "2026-07-30T00:00:00.000Z",
        mode: "ask",
      },
      metadata: { execution_status: "pending_approval" },
    });
  });

  it("falls back to the full config as requested_action when none is declared", async () => {
    const approvals = fakeApprovals();
    const handler = new HumanApprovalHandler(approvals);

    await handler.execute({
      config: { approver_role: "finance" },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(approvals.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAction: { approver_role: "finance" } }),
    );
  });

  it("honors a custom expiry_seconds", async () => {
    const approvals = fakeApprovals();
    const handler = new HumanApprovalHandler(approvals);

    await handler.execute({
      config: { expiry_seconds: 3_600 },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(approvals.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ expirySeconds: 3_600 }),
    );
  });

  it("ignores a non-positive expiry_seconds and falls back to the default", async () => {
    const approvals = fakeApprovals();
    const handler = new HumanApprovalHandler(approvals);

    await handler.execute({
      config: { expiry_seconds: -5 },
      inputs: {},
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
    });

    expect(approvals.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ expirySeconds: 86_400 }),
    );
  });

  it("rejects when tenant/run/node_execution context is missing", async () => {
    const handler = new HumanApprovalHandler(fakeApprovals());

    await expect(
      handler.execute({ config: {}, inputs: {} }),
    ).rejects.toBeInstanceOf(NodeHandlerValidationError);
  });
});
