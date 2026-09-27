import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { WorkflowVersion } from "@/api/types"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("react-router-dom", () => ({
  useParams: () => ({ workflowId: "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b1" }),
}))

import { WorkflowVersions } from "./workflow-versions"

const workflowId = "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b1"

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: "wfv_019a1b2c-3d4e-7f50-8a61-72839405a6b2",
    version: 2,
    status: "tested",
    dagSchemaVersion: "v1",
    trafficPercent: null,
    evaluationRunId: null,
    testedAt: "2026-09-02T00:00:00.000Z",
    evaluationFailedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  }
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <WorkflowVersions />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, "getWorkflow").mockResolvedValue({
    id: workflowId,
    name: "Invoice triage",
    status: "draft",
    runs: 0,
    successRate: 0,
    updatedAt: "2026-09-01T00:00:00.000Z",
  })
})

afterEach(cleanup)

describe("the Deployment Manager's version history", () => {
  it("shows the versions the engine holds, with their real status", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([
      version({ version: 3, status: "canary", trafficPercent: 10 }),
      version({ id: "wfv_older", version: 2, status: "promoted" }),
    ])

    renderScreen()

    expect(await screen.findByText("Version 3")).toBeDefined()
    expect(screen.getByText("Version 2")).toBeDefined()
    expect(screen.getByText("10% of traffic")).toBeDefined()
  })

  it("says so when a workflow has no versions yet", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([])

    renderScreen()

    expect(await screen.findByText("No versions yet")).toBeDefined()
  })

  it("surfaces a failed read instead of an empty history", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockRejectedValue(new Error("Upstream service error"))

    renderScreen()

    expect(await screen.findByText("Upstream service error")).toBeDefined()
  })

  // The lifecycle service refuses transitions its state machine does not
  // allow, so the screen offers only the ones it would accept.
  it.each([
    ["compiled", ["Test"]],
    ["tested", ["Promote", "Start canary"]],
    ["promoted", ["Roll back"]],
    ["rolled_back", []],
    ["retired", []],
  ] as const)("offers %s versions exactly %j", async (status, expected) => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version({ status })])

    renderScreen()
    await screen.findByText("Version 2")

    const actions = ["Test", "Promote", "Start canary", "Roll back"].filter(
      (label) => screen.queryByRole("button", { name: label }) !== null,
    )
    expect(actions).toEqual([...expected])
  })

  it("tests a compiled version, which is the only thing that can be done to one", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version({ status: "compiled" })]);
    const testVersion = vi.spyOn(api, "testWorkflowVersion").mockResolvedValue(undefined);

    renderScreen();
    await userEvent.click(await screen.findByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(testVersion).toHaveBeenCalledWith(
        workflowId,
        "wfv_019a1b2c-3d4e-7f50-8a61-72839405a6b2",
      ),
    );
  });

  it("promotes the version it was asked to promote", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version()])
    const promote = vi.spyOn(api, "promoteWorkflowVersion").mockResolvedValue(undefined)

    renderScreen()
    await userEvent.click(await screen.findByRole("button", { name: "Promote" }))

    await waitFor(() =>
      expect(promote).toHaveBeenCalledWith(
        workflowId,
        "wfv_019a1b2c-3d4e-7f50-8a61-72839405a6b2",
      ),
    )
  })

  it("starts a canary with the traffic share that was typed", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version()])
    const canary = vi.spyOn(api, "startWorkflowVersionCanary").mockResolvedValue(undefined)

    renderScreen()
    await userEvent.click(await screen.findByRole("button", { name: "Start canary" }))
    const traffic = screen.getByLabelText("Traffic share")
    await userEvent.clear(traffic)
    await userEvent.type(traffic, "25")
    await userEvent.click(screen.getByRole("button", { name: "Start canary" }))

    await waitFor(() =>
      expect(canary).toHaveBeenCalledWith(
        workflowId,
        "wfv_019a1b2c-3d4e-7f50-8a61-72839405a6b2",
        25,
      ),
    )
  })

  it("refuses a traffic share the contract would reject", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version()])
    const canary = vi.spyOn(api, "startWorkflowVersionCanary").mockResolvedValue(undefined)

    renderScreen()
    await userEvent.click(await screen.findByRole("button", { name: "Start canary" }))
    const traffic = screen.getByLabelText("Traffic share")
    await userEvent.clear(traffic)
    await userEvent.type(traffic, "150")

    expect(
      (screen.getByRole("button", { name: "Start canary" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(canary).not.toHaveBeenCalled()
  })

  it("rolls back the promoted version", async () => {
    vi.spyOn(api, "getWorkflowVersions").mockResolvedValue([version({ status: "promoted" })])
    const rollback = vi.spyOn(api, "rollbackWorkflowVersion").mockResolvedValue(undefined)

    renderScreen()
    await userEvent.click(await screen.findByRole("button", { name: "Roll back" }))

    await waitFor(() =>
      expect(rollback).toHaveBeenCalledWith(
        workflowId,
        "wfv_019a1b2c-3d4e-7f50-8a61-72839405a6b2",
      ),
    )
  })
})
