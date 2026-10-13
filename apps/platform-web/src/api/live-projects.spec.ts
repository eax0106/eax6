import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", () => ({
  apiGet: vi.fn(),
  apiGetWithEtag: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  mutationKey: (prefix: string) => `${prefix}-test-key`,
}))

import { apiGet, apiPost } from "./http"
import { getProject, getProjects, retryRun, startRun, stopRun } from "./live"

const projectId = "prj_018f47a5-7b2c-7d10-8f11-123456789abc"
const runId = "run_018f47a5-7b2c-7d10-8f11-123456789abc"
const record = {
  id: projectId,
  tenantId: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspaceId: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  name: "Inventory control",
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiPost).mockReset()
})

describe("live projects", () => {
  it("reads the project list the engine pages", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      data: [record],
      page: { next_cursor: null, has_more: false, limit: 50 },
    })

    expect(await getProjects()).toEqual([
      {
        id: projectId,
        name: "Inventory control",
        status: "active",
        brief: undefined,
        plan: undefined,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ])
    expect(apiGet).toHaveBeenCalledWith("/api/v1/projects")
  })

  it("reads one project by its own id", async () => {
    vi.mocked(apiGet).mockResolvedValue(record)

    expect(await getProject(projectId)).toMatchObject({
      id: projectId,
      name: "Inventory control",
      // The row's own word, not silently downgraded to draft.
      status: "active",
    })
    expect(apiGet).toHaveBeenCalledWith(`/api/v1/projects/${projectId}`)
  })
})

describe("live run actions", () => {
  it("starts a run of one version with the user's input", async () => {
    const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc"
    const versionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc"
    vi.mocked(apiPost).mockResolvedValue({ id: runId, status: "running" })

    const run = await startRun(workflowId, versionId, { recipient: "a@example.com" })

    expect(apiPost).toHaveBeenCalledWith(
      "/api/v1/runs",
      { workflow_id: workflowId, workflow_version_id: versionId, input: { recipient: "a@example.com" } },
      { idempotencyKey: "run-start-test-key" },
    )
    expect(run.id).toBe(runId)
  })

  it("cancels a run through its own action route", async () => {
    vi.mocked(apiPost).mockResolvedValue({ run_id: runId, status: "cancelled" })

    await stopRun(runId)

    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/actions/cancel`,
      {},
      { idempotencyKey: "run-cancel-test-key" },
    )
  })

  it("retries one node and re-reads the run", async () => {
    vi.mocked(apiPost).mockResolvedValue({ run_id: runId, status: "running" })
    vi.mocked(apiGet).mockResolvedValue({ run_id: runId, status: "running" })

    await retryRun(runId, "extract")

    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/actions/retry-node`,
      { node_key: "extract" },
      { idempotencyKey: "run-retry-test-key" },
    )
    expect(apiGet).toHaveBeenCalledWith(`/api/v1/runs/${runId}`)
  })
})
