import { z } from "zod"
import { apiGet, apiPut, mutationKey } from "./http"
import type { ApprovalPolicies, ApprovalPolicyChange, ApprovalPolicyStep } from "./types"

const policySchema = z.object({
  node_key: z.string().min(1), mode: z.enum(["ask", "auto"]),
  side_effect_consequence: z.string().nullable(), auto_confirmed_by: z.string().nullable(), auto_confirmed_at: z.string().nullable(),
  skip_on_timeout: z.boolean(), timeout_seconds: z.number().int().nullable(), consecutive_approvals: z.number().int().nonnegative(),
  promotion_suggested: z.boolean(), set_by: z.string().nullable(), updated_at: z.string().nullable(), etag: z.string().min(1),
})
function mapPolicy(raw: unknown): ApprovalPolicyStep {
  const p = policySchema.parse(raw)
  return { nodeKey: p.node_key, mode: p.mode, sideEffectConsequence: p.side_effect_consequence,
    autoConfirmedBy: p.auto_confirmed_by, autoConfirmedAt: p.auto_confirmed_at, skipOnTimeout: p.skip_on_timeout,
    timeoutSeconds: p.timeout_seconds, consecutiveApprovals: p.consecutive_approvals, promotionSuggested: p.promotion_suggested,
    setBy: p.set_by, updatedAt: p.updated_at, etag: p.etag }
}
export async function getApprovalPolicies(workflowId: string): Promise<ApprovalPolicies> {
  const body = z.object({ data: z.array(z.unknown()), can_edit: z.boolean() }).parse(
    await apiGet(`/api/v1/workflows/${encodeURIComponent(workflowId)}/approval-policies`))
  return { policies: body.data.map(mapPolicy), canEdit: body.can_edit }
}
export async function setApprovalPolicy(workflowId: string, nodeKey: string, change: ApprovalPolicyChange, etag: string): Promise<ApprovalPolicyStep> {
  if (!etag) throw new Error("Reload approval settings before saving")
  const body = await apiPut(`/api/v1/workflows/${encodeURIComponent(workflowId)}/approval-policies/${encodeURIComponent(nodeKey)}`,
    { mode: change.mode, skip_on_timeout: change.skipOnTimeout, timeout_seconds: change.timeoutSeconds,
      ...(change.confirmConsequence === undefined ? {} : { confirm_consequence: change.confirmConsequence }) },
    { ifMatch: etag, idempotencyKey: mutationKey("approval-policy") })
  return mapPolicy(body)
}
