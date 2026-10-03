import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { WorkflowHealth } from "@/api/types"
import { WorkflowHealthList } from "./workflow-health"
import { WorkflowDetail } from "./workflow-detail"
vi.mock("@/features/triggers/components/trigger-list", () => ({ TriggerList: () => <div>Triggers</div> }))
vi.mock("@/features/permissions/components/require-permission", () => ({ RequirePermission: () => null }))
const workflow = "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b1"
const dimension = { score: 50, status: "warning" as const, summary: "Recorded observations", passed: 1, observations: 2 }
const health: WorkflowHealth = { workflowId: workflow, overallScore: 50, status: "warning", dimensions: { validation: dimension, availability: dimension, correctness: dimension, reliability: dimension }, recentFailures: 1, degradedRuns: 0, lastEvaluatedAt: "2026-10-03T12:00:00.000Z", window: { startAt: "2026-09-26T12:00:00.000Z", endAt: "2026-10-03T12:00:00.000Z", maximumRuns: 20, sampledRuns: 2 } }
function show(detail = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/workflows/${workflow}`]}>
    <Routes><Route path="/app/workflows/:workflowId" element={detail ? <WorkflowDetail /> : <WorkflowHealthList />} /></Routes>
  </MemoryRouter></QueryClientProvider>)
}
beforeEach(() => vi.restoreAllMocks())
afterEach(cleanup)
it("renders four measured dimensions, real identity, observed window and paginated workflows", async () => {
  const page = vi.spyOn(api, "getWorkflowHealths").mockResolvedValueOnce({ data: [health], page: { next_cursor: "next", has_more: true, limit: 50 } }).mockResolvedValueOnce({ data: [{ ...health, workflowId: "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b2" }], page: { next_cursor: null, has_more: false, limit: 50 } })
  show()
  expect(await screen.findByRole("link", { name: `Workflow ${workflow}` })).toBeDefined()
  for (const name of ["validation", "availability", "correctness", "reliability"]) expect(screen.getByRole("progressbar", { name: `${name} score` })).toBeDefined()
  expect(screen.getByText("2 runs sampled; latest 20 within 7 days.")).toBeDefined()
  expect(screen.getByText("warning")).toBeDefined()
  await userEvent.click(screen.getByRole("button", { name: "Load more workflows" }))
  await waitFor(() => expect(page).toHaveBeenLastCalledWith("next"))
  expect(await screen.findByRole("link", { name: /72839405a6b2/ })).toBeDefined()
})
it("shows unknown dimensions without percentage bars and surfaces live errors", async () => {
  const missing = { score: null, status: "not_enough_data" as const, summary: "No confirmed observations", observations: 0, passed: 0 }
  vi.spyOn(api, "getWorkflowHealths").mockResolvedValue({ data: [{ ...health, overallScore: null, status: "not_enough_data", dimensions: { validation: missing, availability: missing, correctness: missing, reliability: missing } }], page: { next_cursor: null, has_more: false, limit: 50 } })
  show(); expect(await screen.findAllByText("Not enough data")).toHaveLength(5); expect(screen.queryByRole("progressbar")).toBeNull()
  cleanup(); vi.spyOn(api, "getWorkflowHealths").mockRejectedValue(Error("Unavailable")); show()
  expect(await screen.findByText("Failed to load workflow health")).toBeDefined(); expect(screen.queryByRole("link", { name: `Workflow ${workflow}` })).toBeNull()
})
it("shows actual health on workflow detail and exposes retry when the read fails", async () => {
  vi.spyOn(api, "getWorkflow").mockResolvedValue({ id: workflow, name: "Invoice triage", status: "draft", runs: 2, successRate: 50, updatedAt: health.lastEvaluatedAt })
  vi.spyOn(api.costEstimates, "forWorkflow").mockRejectedValue(Error("Unavailable"))
  const read = vi.spyOn(api, "getWorkflowHealth").mockRejectedValueOnce(Error("Unavailable")).mockResolvedValue(health)
  show(true); expect(await screen.findByRole("alert")).toBeDefined()
  await userEvent.click(screen.getByRole("button", { name: "Try Again" }))
  expect(await screen.findByRole("progressbar", { name: "reliability score" })).toBeDefined()
  expect(read).toHaveBeenLastCalledWith(workflow)
})
