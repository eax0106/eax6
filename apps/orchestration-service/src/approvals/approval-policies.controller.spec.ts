import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPoliciesController } from "./approval-policies.controller";
import { ApprovalPolicyService, ApprovalPolicyStaleError } from "./approval-policy.service";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const workflow = `wf_${tenant}`;
const body = { mode: "ask", skip_on_timeout: false, timeout_seconds: null };
function request(overrides: Partial<NonNullable<IdentityTenantGatewayRequest["actorContext"]>> = {}): IdentityTenantGatewayRequest {
  return { headers: {}, url: `/api/v1/workflows/${workflow}/approval-policies/check`, actorContext: {
    tenant_id: `ten_${tenant}`, workspace_id: `ws_${workspace}`, user_id: `usr_${tenant}`,
    actor_type: "user", roles: ["admin"], session_id: "session", jti: "request", permissions: ["approvals:decide"], ...overrides,
  } };
}
function fixture() {
  const service = { list: vi.fn().mockResolvedValue([]), set: vi.fn().mockResolvedValue({ nodeKey: "check", etag: '"current"' }) };
  return { service, controller: new ApprovalPoliciesController(service as unknown as ApprovalPolicyService) };
}
async function status(operation: Promise<unknown>): Promise<number> {
  try { await operation; throw new Error("Expected HTTP refusal"); }
  catch (error) { if (!(error instanceof HttpException)) throw error; return error.getStatus(); }
}
describe("approval policy controller", () => {
  it("requires a nonempty precondition before writing", async () => {
    const { service, controller } = fixture();
    for (const value of [undefined, "", " "]) expect(await status(controller.set(request(), workflow, "check", body, value))).toBe(428);
    expect(service.set).not.toHaveBeenCalled();
  });
  it("passes the real caller and bare database scope, exposing the step ETag", async () => {
    const { service, controller } = fixture();
    await controller.list(request(), workflow);
    expect(service.list).toHaveBeenCalledWith(tenant, workspace, workflow);
    expect(await controller.set(request(), workflow, "check", body, ' "previous" ')).toMatchObject({ node_key: "check", etag: '"current"' });
    expect(service.set).toHaveBeenCalledWith(tenant, workspace, workflow, "check", {
      mode: "ask", skipOnTimeout: false, timeoutSeconds: null, setBy: `usr_${tenant}`,
    }, '"previous"');
  });
  it("returns 412 on a stale precondition and 500 when audit recording fails", async () => {
    const { service, controller } = fixture();
    service.set.mockRejectedValueOnce(new ApprovalPolicyStaleError()).mockRejectedValueOnce(new Error("audit unavailable"));
    expect(await status(controller.set(request(), workflow, "check", body, '"old"'))).toBe(412);
    expect(await status(controller.set(request(), workflow, "check", body, '"current"'))).toBe(500);
  });
  it("refuses nonhuman and unprivileged actors before writing", async () => {
    const { service, controller } = fixture();
    for (const actor of [{ actor_type: "system" as const }, { user_id: null }, { permissions: [] }]) {
      expect(await status(controller.set(request(actor), workflow, "check", body, '"current"'))).toBe(403);
    }
    expect(service.set).not.toHaveBeenCalled();
  });
});
