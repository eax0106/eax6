import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { Run, WorkflowVersion } from "@/api/types"

const navigate = vi.fn()
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }))

import { parseRunInput, runnableVersions, RunWithInputDialog } from "./run-with-input-dialog"

const workflowId = "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b1"

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: "wfv_019a1b2c-3d4e-7f50-8a61-72839405a6b2",
    version: 1,
    status: "compiled",
    dagSchemaVersion: "v1",
    trafficPercent: null,
    evaluationRunId: null,
    testedAt: null,
    evaluationFailedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  }
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RunWithInputDialog workflowId={workflowId} open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  navigate.mockReset()
})

afterEach(cleanup)

describe("run input", () => {
  it("accepts only a JSON object", () => {
    expect(parseRunInput("{\"recipient\": \"a@example.com\"}")).toEqual({ recipient: "a@example.com" })
    expect(parseRunInput("[1]")).toMatch(/JSON object/)
    expect(parseRunInput("null")).toMatch(/JSON object/)
    expect(parseRunInput("{recipient")).toMatch(/valid JSON/)
  })

  it("offers runnable versions, promoted first, then newest", () => {
    const ids = runnableVersions([
      version({ id: "wfv_old", version: 1 }),
      version({ id: "wfv_retired", version: 4, status: "retired" }),
      version({ id: "wfv_new", version: 3 }),
      version({ id: "wfv_live", version: 2, status: "promoted" }),
    ]).map(v => v.id)
    expect(ids).toEqual(["wfv_live", "wfv_new", "wfv_old"])
  })
})

describe("the Run with input dialog", () => {
  it("starts the newest compiled version with the typed input and opens the run", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version({ id: "wfv_new", version: 2 }), version()])
    const startRun = vi.spyOn(api, "startRun").mockResolvedValue({ id: "run_123" } as Run)
    renderDialog()

    const input = screen.getByLabelText("Input (JSON)")
    await userEvent.clear(input)
    await userEvent.type(input, "{{\"title\": \"Weekly sync\"}")
    await waitFor(() => expect((screen.getByLabelText("Version") as HTMLSelectElement).value).toBe("wfv_new"))
    await userEvent.click(screen.getByRole("button", { name: "Start run" }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/runs/run_123"))
    expect(startRun).toHaveBeenCalledWith(workflowId, "wfv_new", { title: "Weekly sync" })
  })

  it("will not start a run from input that is not an object", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version()])
    const startRun = vi.spyOn(api, "startRun")
    renderDialog()

    const input = screen.getByLabelText("Input (JSON)")
    await userEvent.clear(input)
    await userEvent.type(input, "[[1]")

    expect(await screen.findByText(/must be a JSON object/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement).disabled).toBe(true)
    expect(startRun).not.toHaveBeenCalled()
  })
})
