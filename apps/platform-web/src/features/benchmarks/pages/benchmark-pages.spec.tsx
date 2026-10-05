import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const access = vi.hoisted(() => ({ canCreate: true }))
vi.mock("@/api/http", async original => ({ ...await original<typeof import("@/api/http")>(), isLiveApi: true }))
vi.mock("@/features/permissions/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: (permission: string) => permission === "benchmark.read" || (permission === "benchmark.create" && access.canCreate) }),
}))
vi.mock("@/api/client", async () => {
  const { benchmarksService } = await import("@/api/services/benchmarks")
  return { api: { benchmarks: benchmarksService, getWorkflows: async () => [
    { id: "wf_active", name: "Lead capture", status: "active" },
    { id: "wf_draft", name: "Draft flow", status: "draft" },
  ] } }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BenchmarkListPage } from "./benchmark-list"
import { CreateBenchmarkPage } from "./create-benchmark"
import { BenchmarkDetailPage } from "./benchmark-detail"

const at = "2026-10-05T12:00:00+00:00"
const dataset = { id: "ds1", name: "Lead checks", description: "Two leads", caseCount: 1, createdBy: "usr", createdAt: at,
  cases: [{ id: "c1", position: 0, input: { name: "Asha" }, successCriteria: ["Greets Asha"] }] }
const run = { id: "run1", datasetId: "ds1", workflowId: "wf_active", workflowVersionId: "wfv", status: "completed", caseCount: 1,
  passed: 1, failed: 0, errored: 0, passRate: 1, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.0012, error: null,
  requestedBy: "usr", createdAt: at, startedAt: at, completedAt: at }
const runDetail = { ...run, results: [{ caseId: "c1", position: 0, verdict: "pass", score: 0.92, threshold: 0.7, reviewerModel: "r",
  output: {}, steps: [{ key: "draft", type: "LLMTask", status: "executed" }, { key: "send", type: "ToolCall", status: "simulated", action: "ToolCall:email.send" }],
  inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.0012, durationMs: 40, error: null }] }

const fetcher = vi.fn<typeof fetch>()
beforeEach(() => { access.canCreate = true; fetcher.mockReset(); vi.stubGlobal("fetch", fetcher) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function route(url: string | URL | Request) {
  const path = new URL(String(url), "http://app.test")
  return path.pathname + (path.search ? path.search : "")
}

function view(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/benchmarks" element={<BenchmarkListPage />} />
          <Route path="/app/benchmarks/new" element={<CreateBenchmarkPage />} />
          <Route path="/app/benchmarks/:benchmarkId" element={<BenchmarkDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("benchmarks area", () => {
  it("lists datasets with their latest run", async () => {
    fetcher.mockImplementation(async url => route(url).startsWith("/api/v1/benchmarks/runs") ? Response.json({ data: [run] }) : Response.json({ data: [dataset] }))
    view("/app/benchmarks")
    await screen.findByText("Lead checks")
    expect(screen.getByText("100% passed (1 of 1)")).toBeTruthy()
    expect(screen.getByRole("button", { name: /New dataset/ })).toBeTruthy()
  })

  it("shows an empty state and hides creation without permission", async () => {
    access.canCreate = false
    fetcher.mockImplementation(async () => Response.json({ data: [] }))
    view("/app/benchmarks")
    await screen.findByText("No benchmark datasets")
    expect(screen.queryByRole("button", { name: /New dataset/ })).toBeNull()
  })

  it("reports a failed load instead of an empty list", async () => {
    fetcher.mockImplementation(async () => Response.json({ detail: "busy" }, { status: 503 }))
    view("/app/benchmarks")
    await screen.findByText("Benchmarks could not be loaded")
    expect(screen.queryByText("No benchmark datasets")).toBeNull()
  })

  it("validates cases before creating a dataset", async () => {
    fetcher.mockImplementation(async () => Response.json(dataset, { status: 201 }))
    view("/app/benchmarks/new")
    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Name the dataset.")
    expect(alert.textContent).toContain("Case 1: add at least one success criterion.")
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lead checks" } })
    fireEvent.change(screen.getByLabelText("Input (JSON object)"), { target: { value: "[1]" } })
    fireEvent.change(screen.getByLabelText("Success criteria (one per line)"), { target: { value: "Greets Asha" } })
    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Case 1: the input must be a JSON object."))
    expect(fetcher).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("Input (JSON object)"), { target: { value: '{"name": "Asha"}' } })
    fireEvent.click(screen.getByRole("button", { name: "Add case" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove case 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      name: "Lead checks", description: "", cases: [{ input: { name: "Asha" }, successCriteria: ["Greets Asha"] }] })
  })

  it("runs an active workflow against a dataset and shows per-case results", async () => {
    fetcher.mockImplementation(async (url, init) => {
      const path = route(url)
      if (init?.method === "POST") return Response.json(runDetail, { status: 202 })
      if (path.startsWith("/api/v1/benchmarks/runs/")) return Response.json(runDetail)
      if (path.startsWith("/api/v1/benchmarks/runs")) return Response.json({ data: [run] })
      return Response.json(dataset)
    })
    view("/app/benchmarks/ds1")
    await screen.findByText("Lead checks")
    const select = screen.getByLabelText("Run a workflow against this dataset") as HTMLSelectElement
    expect(Array.from(select.options, option => option.textContent)).toEqual(["Choose a workflow", "Lead capture"])
    fireEvent.change(select, { target: { value: "wf_active" } })
    fireEvent.click(screen.getByRole("button", { name: /Run$/ }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true))
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!
    expect(route(post[0])).toBe("/api/v1/benchmarks/datasets/ds1/runs")
    expect(JSON.parse(String(post[1]!.body))).toEqual({ workflowId: "wf_active" })
    await screen.findByText(/Passed · score 0.92/)
    expect(screen.getByText(/send: simulated ToolCall:email.send/)).toBeTruthy()
    expect(screen.getByText("$0.0012")).toBeTruthy()
    expect(screen.getByText("Greets Asha")).toBeTruthy()
  })

  it("hides the run control from members who cannot create", async () => {
    access.canCreate = false
    fetcher.mockImplementation(async url => route(url).startsWith("/api/v1/benchmarks/runs") ? Response.json({ data: [] }) : Response.json(dataset))
    view("/app/benchmarks/ds1")
    await screen.findByText("No runs yet.")
    expect(screen.queryByLabelText("Run a workflow against this dataset")).toBeNull()
  })

  it("reports a dataset that cannot be found", async () => {
    fetcher.mockImplementation(async () => Response.json({ detail: "missing" }, { status: 404 }))
    view("/app/benchmarks/ds1")
    await screen.findByText("Dataset not found")
  })
})
