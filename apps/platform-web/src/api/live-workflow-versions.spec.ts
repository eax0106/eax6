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
import {
  getWorkflowVersions,
  testWorkflowVersion,
  promoteWorkflowVersion,
  rollbackWorkflowVersion,
  startWorkflowVersionCanary,
} from "./live"

const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc"
const versionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc"

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiPost).mockReset()
  vi.mocked(apiPost).mockResolvedValue({})
})

describe("a workflow's version history", () => {
  it("reads the versions the engine holds, with the deployment fields the screen shows", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      data: [
        {
          id: versionId,
          workflowId,
          version: 3,
          status: "canary",
          dagSchemaVersion: "v1",
          trafficPercent: 10,
          evaluationRunId: "run_1",
          testedAt: "2026-09-02T00:00:00.000Z",
          evaluationFailedAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      page: { next_cursor: null, has_more: false, limit: 50 },
    })

    expect(await getWorkflowVersions(workflowId)).toEqual([
      {
        id: versionId,
        version: 3,
        status: "canary",
        dagSchemaVersion: "v1",
        trafficPercent: 10,
        evaluationRunId: "run_1",
        testedAt: "2026-09-02T00:00:00.000Z",
        evaluationFailedAt: null,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ])
    expect(apiGet).toHaveBeenCalledWith(`/api/v1/workflows/${workflowId}/versions?limit=50`)
  })

  it("keeps a status it does not recognise out of the screen's vocabulary", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      data: [{ id: versionId, version: 1, status: "something_new", createdAt: "2026-09-01T00:00:00.000Z" }],
    })

    const [version] = await getWorkflowVersions(workflowId)

    expect(version?.status).toBe("compiled")
  })
})

describe("the four things the lifecycle contract allows", () => {
  it("tests a compiled version", async () => {
    await testWorkflowVersion(workflowId, versionId)

    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}/actions/test-version`,
      { workflowVersionId: versionId },
      { idempotencyKey: "workflow-test-version-test-key" },
    )
  })

  it("promotes a version", async () => {
    await promoteWorkflowVersion(workflowId, versionId)

    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}/actions/promote-version`,
      { workflowVersionId: versionId },
      { idempotencyKey: "workflow-promote-version-test-key" },
    )
  })

  it("starts a canary on a share of traffic", async () => {
    await startWorkflowVersionCanary(workflowId, versionId, 10)

    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}/actions/start-canary`,
      { workflowVersionId: versionId, trafficPercent: 10 },
      { idempotencyKey: "workflow-start-canary-test-key" },
    )
  })

  it("rolls a version back", async () => {
    await rollbackWorkflowVersion(workflowId, versionId)

    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}/actions/rollback`,
      { workflowVersionId: versionId },
      { idempotencyKey: "workflow-rollback-test-key" },
    )
  })
})
