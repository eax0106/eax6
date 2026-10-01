import type { HumanAction } from "@/api/types"
import { ApprovalPolicyControls } from "@/features/workflows/components/approval-policy-controls"

export function ApprovalPolicySection({ action }: { action: HumanAction }) {
  if (action.type !== "approval") return null
  return <div className="space-y-3 rounded-xl border border-border bg-surface p-6">
    {action.approvalMode === "auto" && <p>Approved by policy{action.policySetBy ? ` set by ${action.policySetBy}` : ""}.</p>}
    {action.approvalStatus === "skipped" && <p>Skipped after timeout. Run flagged for review.</p>}
    {action.workflowId && action.approvalNodeKey
      ? <ApprovalPolicyControls workflowId={action.workflowId} nodeKey={action.approvalNodeKey} />
      : <p>Approval settings are unavailable for this action.</p>}
  </div>
}
