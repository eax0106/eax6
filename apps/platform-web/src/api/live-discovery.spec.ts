import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { discoveryService } from "./services/discovery"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const rec = (id: string, status: string) => ({
  id, tenantId: "t", workspaceId: "w", problemStatement: `Automate ${id}`, evidence: {}, estimatedValue: 5,
  estimatedEffort: 2, requiredIntegrations: ["slack"], riskLevel: "medium", confidence: 0.72, status, createdAt: "x",
})

describe("live discovery (B3.3)", () => {
  it("shows only open suggestions from the workspace's own activity", async () => {
    fetchMock.mockResolvedValue(Response.json([rec("r1", "suggested"), rec("r2", "accepted"), rec("r3", "dismissed")]))
    const list = await discoveryService.listSuggestions()
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/discovery/recommendations")
    expect(list).toEqual([{ id: "r1", problemStatement: "Automate r1", estimatedValue: 5, estimatedEffort: 2, requiredIntegrations: ["slack"], riskLevel: "medium", confidence: 0.72 }])
  })

  it("accepts idempotently and returns the draft workflow it created", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...rec("r1", "accepted"), evidence: { created_workflow_id: "wf_9" } }))
    await expect(discoveryService.acceptSuggestion("r1")).resolves.toBe("wf_9")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/discovery/recommendations/r1/actions/accept")
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^discovery-accept/)
    fetchMock.mockResolvedValue(Response.json(rec("r1", "accepted")))
    await expect(discoveryService.acceptSuggestion("r1")).rejects.toThrow(/not returned/)
  })

  it("drops the demo's template placeholders and invented recommendations", async () => {
    const catalogue = await discoveryService.listUseCases()
    expect(catalogue.length).toBeGreaterThan(0)
    expect(catalogue.every((uc) => uc.starterPrompt && !uc.workflowTemplateId && !uc.projectTemplateId)).toBe(true)
    await expect(discoveryService.getRecommendations()).resolves.toEqual([])
  })
})
