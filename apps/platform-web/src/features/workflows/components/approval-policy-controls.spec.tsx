import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import { ApiHttpError } from "@/api/http"
import type { ApprovalPolicyStep } from "@/api/types"
import { ApprovalPolicyControls } from "./approval-policy-controls"

const step: ApprovalPolicyStep = { nodeKey: "approval", mode: "ask", sideEffectConsequence: "send customer email", autoConfirmedBy: null, autoConfirmedAt: null, skipOnTimeout: false, timeoutSeconds: null, consecutiveApprovals: 10, promotionSuggested: true, setBy: null, updatedAt: null, etag: '"v1"' }
function renderControls() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ApprovalPolicyControls workflowId="wf_1" nodeKey="approval" /></QueryClientProvider>)
}
beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(api, "getApprovalPolicies").mockResolvedValue({ policies: [step], canEdit: true }) })
afterEach(cleanup)
it("suggests without changing mode and requires consequence confirmation before saving", async () => {
  const save = vi.spyOn(api, "setApprovalPolicy").mockResolvedValue({ ...step, mode: "auto", etag: '"v2"' })
  renderControls()
  expect((await screen.findByLabelText("Ask me first") as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText(/last 10 in a row/)).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
  await userEvent.click(screen.getByLabelText("Always go ahead"))
  expect((screen.getByRole("button", { name: "Save approval settings" }) as HTMLButtonElement).disabled).toBe(true)
  await userEvent.click(screen.getByLabelText("I understand: send customer email"))
  await userEvent.click(screen.getByRole("button", { name: "Save approval settings" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith("wf_1", "approval", { mode: "auto", skipOnTimeout: false, timeoutSeconds: null, confirmConsequence: "send customer email" }, '"v1"'))
})
it("requires a bounded timeout and keeps its saved window when skip is turned off", async () => {
  const save = vi.spyOn(api, "setApprovalPolicy").mockResolvedValue({ ...step, skipOnTimeout: true, timeoutSeconds: 120, etag: '"v2"' })
  renderControls()
  await userEvent.click(await screen.findByLabelText("Skip on timeout and flag the run"))
  const input = screen.getByLabelText("Timeout window (seconds)")
  await userEvent.clear(input); await userEvent.type(input, "59")
  expect((screen.getByRole("button", { name: "Save approval settings" }) as HTMLButtonElement).disabled).toBe(true)
  await userEvent.clear(input); await userEvent.type(input, "120")
  await userEvent.click(screen.getByRole("button", { name: "Save approval settings" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith("wf_1", "approval", { mode: "ask", skipOnTimeout: true, timeoutSeconds: 120 }, '"v1"'))
  await waitFor(() => expect((screen.getByRole("button", { name: "Save approval settings" }) as HTMLButtonElement).disabled).toBe(true))
  await userEvent.click(screen.getByLabelText("Skip on timeout and flag the run"))
  await userEvent.click(screen.getByRole("button", { name: "Save approval settings" }))
  await waitFor(() => expect(save).toHaveBeenLastCalledWith("wf_1", "approval", { mode: "ask", skipOnTimeout: false, timeoutSeconds: 120 }, '"v2"'))
})
it("does not let readers change settings", async () => {
  vi.mocked(api.getApprovalPolicies).mockResolvedValue({ policies: [step], canEdit: false })
  const save = vi.spyOn(api, "setApprovalPolicy")
  renderControls()
  const auto = await screen.findByLabelText("Always go ahead")
  expect(auto.matches(":disabled")).toBe(true)
  await userEvent.click(auto)
  expect((auto as HTMLInputElement).checked).toBe(false)
  expect(save).not.toHaveBeenCalled()
})
it("reloads stale settings and uses the fresh ETag on the next save", async () => {
  const read = vi.mocked(api.getApprovalPolicies).mockResolvedValueOnce({ policies: [step], canEdit: true }).mockResolvedValue({ policies: [{ ...step, timeoutSeconds: 300, etag: '"v2"' }], canEdit: true })
  const save = vi.spyOn(api, "setApprovalPolicy").mockRejectedValueOnce(new ApiHttpError({ code: "ETAG_MISMATCH", message: "changed" } as never, 412)).mockResolvedValue({ ...step, skipOnTimeout: true, timeoutSeconds: 300, etag: '"v3"' })
  renderControls()
  await userEvent.click(await screen.findByLabelText("Skip on timeout and flag the run"))
  await userEvent.click(screen.getByRole("button", { name: "Save approval settings" }))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await waitFor(() => expect((screen.getByLabelText("Skip on timeout and flag the run") as HTMLInputElement).checked).toBe(false))
  await userEvent.click(screen.getByLabelText("Skip on timeout and flag the run"))
  expect((screen.getByLabelText("Timeout window (seconds)") as HTMLInputElement).value).toBe("300")
  await userEvent.click(screen.getByRole("button", { name: "Save approval settings" }))
  await waitFor(() => expect(save).toHaveBeenLastCalledWith("wf_1", "approval", { mode: "ask", skipOnTimeout: true, timeoutSeconds: 300 }, '"v2"'))
})

it("loads approval settings for the selected builder graph step", async () => {
  const { useBuilderStore } = await import("../stores/useBuilderStore")
  const { Inspector } = await import("./builder/inspector")
  vi.spyOn(api, "getNodeTypes").mockResolvedValue([])
  useBuilderStore.setState({ workflowId: "wf_1", selectedNodeId: "approval", nodes: [{ id: "approval", type: "HumanApproval", position: { x: 0, y: 0 }, data: { label: "Email approval" } }] })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Inspector /></QueryClientProvider>)
  expect(await screen.findByLabelText("Ask me first")).toBeTruthy()
  expect(api.getApprovalPolicies).toHaveBeenCalledWith("wf_1")
})
