import { ApiHttpError } from "../http"
import { delay, mockHumanActions } from "./data"
import type { ApprovalPolicies, ApprovalPolicyChange, ApprovalPolicyStep } from "../types"
const policies = new Map<string, ApprovalPolicyStep[]>()
function read(workflowId: string): ApprovalPolicyStep[] {
  if (!policies.has(workflowId)) {
    policies.set(workflowId, mockHumanActions.filter(a => a.workflowId === workflowId && a.type === "approval").map(a => ({
      nodeKey: a.approvalNodeKey ?? "approval", mode: "ask", sideEffectConsequence: "this will act outside Alter without asking",
      autoConfirmedBy: null, autoConfirmedAt: null, skipOnTimeout: false, timeoutSeconds: null, consecutiveApprovals: 0,
      promotionSuggested: false, setBy: null, updatedAt: null, etag: '"default"',
    })))
  }
  return policies.get(workflowId)!
}
export async function getMockApprovalPolicies(workflowId: string): Promise<ApprovalPolicies> {
  await delay(100)
  return { policies: structuredClone(read(workflowId)), canEdit: true }
}
export async function setMockApprovalPolicy(workflowId: string, nodeKey: string, change: ApprovalPolicyChange, etag: string): Promise<ApprovalPolicyStep> {
  await delay(100)
  const step = read(workflowId).find(p => p.nodeKey === nodeKey)
  if (!step) throw new Error("Approval step not found")
  if (step.etag !== etag) throw new ApiHttpError({ code: "ETAG_MISMATCH", message: "Approval settings changed; reload them" } as never, 412)
  if (change.skipOnTimeout && change.timeoutSeconds === null) throw new Error("Choose a timeout window")
  if (change.timeoutSeconds !== null && (!Number.isInteger(change.timeoutSeconds) || change.timeoutSeconds < 60 || change.timeoutSeconds > 2_592_000)) throw new Error("Invalid timeout window")
  const confirmed = change.mode === "auto" && step.sideEffectConsequence !== null
  if (confirmed && change.confirmConsequence !== step.sideEffectConsequence) throw new Error("Confirm the consequence")
  Object.assign(step, { mode: change.mode, skipOnTimeout: change.skipOnTimeout, timeoutSeconds: change.timeoutSeconds,
    autoConfirmedBy: confirmed ? "mock-user" : null, autoConfirmedAt: confirmed ? new Date().toISOString() : null,
    consecutiveApprovals: change.mode === "auto" ? 0 : step.consecutiveApprovals, promotionSuggested: change.mode === "auto" ? false : step.promotionSuggested,
    setBy: "mock-user", updatedAt: new Date().toISOString(), etag: `"${crypto.randomUUID()}"` })
  return structuredClone(step)
}
