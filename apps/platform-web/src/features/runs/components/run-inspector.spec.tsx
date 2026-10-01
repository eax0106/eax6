import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("@/api/http", () => ({ apiGet: vi.fn() }))
vi.mock("@/api/client", async () => {
  const live = await import("@/api/live")
  return { api: { getNodeVerification: live.getNodeVerification } }
})
vi.mock("../stores/useRunStreamStore", () => ({ useRunStreamStore: () => ({
  selectedNodeId: "node_click", setSelectedNodeId: vi.fn(),
  nodeExecutions: { node_click: { nodeId: "node_click", runId: "run_readback", nodeName: "Click", status: "completed", attempt: 1 } },
}) }))

import { apiGet } from "@/api/http"
import { RunInspector } from "./run-inspector"

afterEach(cleanup)

it("labels persisted unconfirmed clicks as warnings through the live adapter and real verification tab", async () => {
  vi.mocked(apiGet).mockResolvedValue([
    { id: "ver_click", node_execution_id: "node_click", gate_type: "mechanical", verdict: "warn",
      details: { message: "Unconfirmed: No expected page state declared" } },
    { id: "ver_other", node_execution_id: "node_other", gate_type: "quality", verdict: "pass" },
  ])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><RunInspector /></QueryClientProvider>)
  await userEvent.setup().click(screen.getByRole("tab", { name: "Verify" }))
  expect(await screen.findByText("Unconfirmed: No expected page state declared")).toBeTruthy()
  expect(screen.getByText("0/1 checks passed")).toBeTruthy()
  expect(screen.getAllByText("warning")).toHaveLength(2)
  expect(apiGet).toHaveBeenCalledWith("/api/v1/runs/run_readback/verification-results")
})
