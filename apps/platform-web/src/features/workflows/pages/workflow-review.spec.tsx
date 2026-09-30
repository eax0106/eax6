import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { Connection, Trigger, Workflow } from "@/api/types"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("../components/safeguards-section", () => ({
  SafeguardsSection: () => <div>Safeguards</div>,
}))

import { WorkflowReview } from "./workflow-review"

const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc"

const workflow: Workflow = {
  id: workflowId,
  name: "Send the daily digest",
  status: "draft",
  runs: 0,
  successRate: 0,
  updatedAt: "2026-09-24T00:00:00.000Z",
  dag: {
    schema_version: "1.0",
    entry_node_keys: ["prepare"],
    nodes: [
      { key: "prepare", type: "LLMTask", config: {}, metadata: { ui: {} } },
      { key: "approve", type: "HumanApproval", config: {}, metadata: { ui: {} } },
      {
        key: "send",
        type: "ToolCall",
        config: {
          tool_name: "slack.send",
          arguments: {},
          credential_ref:
            "/alter/prod/tenant/ten_018f47a5-7b2c-7d10-8f11-123456789abc/integration/slack/access-token",
        },
        metadata: { ui: {} },
      },
    ],
    edges: [
      { key: "prepare-approve", from: "prepare", to: "approve", kind: "sequential" },
      { key: "approve-send", from: "approve", to: "send", kind: "sequential" },
    ],
    waves: [
      { key: "prepare-wave", order: 0, node_keys: ["prepare"], depends_on: [] },
      { key: "approve-wave", order: 1, node_keys: ["approve"], depends_on: ["prepare-wave"] },
      { key: "send-wave", order: 2, node_keys: ["send"], depends_on: ["approve-wave"] },
    ],
  },
}

const trigger: Trigger = {
  id: "trg_018f47a5-7b2c-7d10-8f11-123456789abc",
  workflowId,
  type: "schedule",
  name: "Weekday schedule",
  enabled: true,
  status: "configured",
  config: {},
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
}

const connection: Connection = {
  id: "conn_018f47a5-7b2c-7d10-8f11-123456789abc",
  integrationId: "slack",
  name: "Slack workspace",
  status: "connected",
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
}

function renderReview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/app/workflows/${workflowId}/review`]}>
        <Routes>
          <Route path="/app/workflows/:workflowId/review" element={<WorkflowReview />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("Review & Activate", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, "getWorkflow").mockResolvedValue(workflow)
    vi.spyOn(api, "getTriggers").mockResolvedValue([trigger])
    vi.spyOn(api, "getConnections").mockResolvedValue([connection])
    vi.spyOn(api, "activateWorkflow").mockResolvedValue(undefined)
    vi.spyOn(api, "getRunEstimate").mockResolvedValue({
      atMostMinor: 125050,
      usuallyMinor: null,
      sampleRuns: 0,
      unpricedCalls: 0,
    })
  })

  afterEach(cleanup)

  it("summarizes the workflow's actual DAG and triggers instead of fabricated values", async () => {
    renderReview()

    expect(await screen.findByText("Weekday schedule")).toBeTruthy()
    expect(screen.getByText("3 nodes")).toBeTruthy()
    expect(await screen.findByText("Connections ready")).toBeTruthy()
    expect(screen.queryByText("Incoming Webhook")).toBeNull()
    expect(screen.queryByText("Mock Connection Used")).toBeNull()
    expect(screen.queryByText("Configuration Complete")).toBeNull()
  })

  it("fails closed when no compiled workflow graph is available", async () => {
    vi.mocked(api.getWorkflow).mockResolvedValue({ ...workflow, dag: undefined })

    renderReview()

    expect(await screen.findByText("Workflow graph unavailable")).toBeTruthy()
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Activate Workflow" }) as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it("labels connection readiness as unknown when a credential reference cannot be matched", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([])

    renderReview()

    expect(await screen.findByText("Connection status unverified")).toBeTruthy()
  })
  it("shows only the worst case before five verified runs exist (D4)", async () => {
    renderReview()

    expect(await screen.findByText("at most ₹1,250.50")).toBeTruthy()
    expect(api.getRunEstimate).toHaveBeenCalledWith(workflowId)
  })

  it("shows the usual cost beside the worst case once five runs exist, and flags unpriced steps", async () => {
    vi.mocked(api.getRunEstimate).mockResolvedValue({
      atMostMinor: 90000,
      usuallyMinor: 4210,
      sampleRuns: 5,
      unpricedCalls: 1,
    })

    renderReview()

    expect(await screen.findByText("usually ₹42.10 (last 5 runs), at most ₹900.00")).toBeTruthy()
    expect(screen.getByText(/1 step has no price on record yet/)).toBeTruthy()
  })

  it("says the estimate is unavailable rather than inventing one", async () => {
    vi.mocked(api.getRunEstimate).mockRejectedValue(new Error("down"))

    renderReview()

    expect(await screen.findByText("Unavailable")).toBeTruthy()
  })
})
