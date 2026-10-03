import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("./http", async importOriginal => ({ ...(await importOriginal<typeof import("./http")>()), isLiveApi: true }))
import { api } from "./client"
const workflow = "wf_019a1b2c-3d4e-7f50-8a61-72839405a6b1"
const dimension = { score: 50, status: "warning", summary: "Recorded observations", passed: 1, observations: 2 }
const health = { workflowId: workflow, overallScore: 50, status: "warning", dimensions: { validation: dimension, availability: dimension, correctness: dimension, reliability: dimension }, recentFailures: 1, degradedRuns: 0, lastEvaluatedAt: "2026-10-03T12:00:00.000Z", window: { startAt: "2026-09-26T12:00:00.000Z", endAt: "2026-10-03T12:00:00.000Z", maximumRuns: 20, sampledRuns: 2 } }
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock) })
afterEach(() => vi.unstubAllGlobals())
it("reads actual paginated workspace health and detail through the live client", async () => {
  const page = { data: [health], page: { next_cursor: "next cursor", has_more: true, limit: 50 } }
  fetchMock.mockResolvedValueOnce(Response.json(page)).mockResolvedValueOnce(Response.json(health))
  expect(await api.getWorkflowHealths("prior cursor")).toEqual(page)
  expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/workflows/health?limit=50&cursor=prior+cursor")
  expect(await api.getWorkflowHealth(workflow)).toEqual(health)
  expect(String(fetchMock.mock.calls[1]![0])).toContain(`/api/v1/workflows/${workflow}/health`)
})
it("propagates server errors and rejects fabricated or malformed health without mock fallback", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ detail: "Unavailable" }, { status: 503 })).mockResolvedValueOnce(Response.json({ ...health, workflowId: "demo" }))
  await expect(api.getWorkflowHealths()).rejects.toThrow()
  await expect(api.getWorkflowHealth(workflow)).rejects.toThrow()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
it("retains an unknown score and counts rather than manufacturing health", async () => {
  const missing = { score: null, status: "not_enough_data", summary: "No confirmed observations", passed: 0, observations: 0 }
  fetchMock.mockResolvedValue(Response.json({ ...health, overallScore: null, status: "not_enough_data", dimensions: { validation: missing, availability: missing, correctness: missing, reliability: missing }, window: { ...health.window, sampledRuns: 0 } }))
  expect(await api.getWorkflowHealth(workflow)).toMatchObject({ overallScore: null, status: "not_enough_data", window: { sampledRuns: 0 } })
})
