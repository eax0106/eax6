import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { HumanAction } from "@/api/types"
vi.mock("@/features/workflows/components/approval-policy-controls", () => ({ ApprovalPolicyControls: ({ workflowId, nodeKey }: { workflowId: string; nodeKey: string }) => <p>{workflowId}:{nodeKey}</p> }))
import { ApprovalPolicySection } from "./approval-policy-section"
afterEach(cleanup)
const action = { type: "approval", workflowId: "wf_1", approvalNodeKey: "approval", approvalMode: "auto", policySetBy: "usr_1", approvalStatus: "skipped" } as HumanAction
it("uses graph key and explains recorded policy and timeout outcomes", () => {
  render(<ApprovalPolicySection action={action} />)
  expect(screen.getByText("wf_1:approval")).toBeTruthy()
  expect(screen.getByText("Approved by policy set by usr_1.")).toBeTruthy()
  expect(screen.getByText("Skipped after timeout. Run flagged for review.")).toBeTruthy()
})
it("does not put approval controls on other action types", () => {
  const { container } = render(<ApprovalPolicySection action={{ ...action, type: "escalation" }} />)
  expect(container.textContent).toBe("")
})
