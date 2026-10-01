import { beforeEach, expect, it, vi } from "vitest"
vi.mock("./http", () => ({ apiGet: vi.fn(), apiPut: vi.fn(), mutationKey: () => "approval-policy-test" }))
import { apiGet, apiPut } from "./http"
import { getApprovalPolicies, setApprovalPolicy } from "./live-approval-policies"
const raw = { node_key: "approval", mode: "ask", side_effect_consequence: "send email", auto_confirmed_by: null, auto_confirmed_at: null, skip_on_timeout: true, timeout_seconds: 300, consecutive_approvals: 10, promotion_suggested: true, set_by: "usr_1", updated_at: "2026-10-01", etag: '"v1"' }
beforeEach(() => vi.resetAllMocks())
it("reads rights, consequence, timeout, suggestion and current ETag", async () => {
  vi.mocked(apiGet).mockResolvedValue({ data: [raw], can_edit: false })
  expect(await getApprovalPolicies("wf_1")).toMatchObject({ canEdit: false, policies: [{ nodeKey: "approval", mode: "ask", sideEffectConsequence: "send email", skipOnTimeout: true, timeoutSeconds: 300, consecutiveApprovals: 10, promotionSuggested: true, setBy: "usr_1", etag: '"v1"' }] })
})
it("sends confirmation, exact precondition and idempotency metadata", async () => {
  vi.mocked(apiPut).mockResolvedValue({ ...raw, mode: "auto" })
  await setApprovalPolicy("wf_1", "approval", { mode: "auto", skipOnTimeout: true, timeoutSeconds: 300, confirmConsequence: "send email" }, '"v1"')
  expect(apiPut).toHaveBeenCalledWith("/api/v1/workflows/wf_1/approval-policies/approval", { mode: "auto", skip_on_timeout: true, timeout_seconds: 300, confirm_consequence: "send email" }, { ifMatch: '"v1"', idempotencyKey: "approval-policy-test" })
})
it("refuses missing ETags and malformed server records", async () => {
  await expect(setApprovalPolicy("wf_1", "approval", { mode: "ask", skipOnTimeout: false, timeoutSeconds: null }, "")).rejects.toThrow(/Reload/)
  expect(apiPut).not.toHaveBeenCalled()
  vi.mocked(apiGet).mockResolvedValue({ data: [{ ...raw, etag: undefined }], can_edit: true })
  await expect(getApprovalPolicies("wf_1")).rejects.toThrow()
})
