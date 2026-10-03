import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", () => ({
  apiGet: vi.fn(),
  apiGetWithEtag: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  mutationKey: (prefix: string) => `${prefix}-test-key`,
  isLiveApi: true,
}))

import { apiGet, apiPost } from "./http"
import { api } from "./client"
import { answerProjectClarification, getProjectClarifications } from "./live"

const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc"
const projectId = "prj_018f47a5-7b2c-7d10-8f11-123456789abc"
const clarificationId = "clr_018f47a5-7b2c-7d10-8f11-123456789abc"

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiPost).mockReset()
})

describe("a workflow plan that needs clarifying", () => {
  it("returns the planner's own questions", async () => {
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path.endsWith("/actions/plan")) {
        return { type: "clarification", questions: ["Which inbox?", "Who approves?"] } as never
      }
      return { id: workflowId, name: "Triage", status: "draft" } as never
    })

    const result = await api.compileWorkflow({ goal: "Triage support mail", answers: {} })

    expect(result.questions).toEqual(["Which inbox?", "Who approves?"])
  })

  it("re-plans the workflow that asked, with the original goal and the answers", async () => {
    vi.mocked(apiGet).mockResolvedValue({ id: workflowId, name: "Triage", status: "draft" })
    vi.mocked(apiPost).mockResolvedValue({ type: "compiled", versionId: "wfv_1" })

    await api.compileWorkflow({
      goal: "Triage support mail",
      answers: { "Which inbox?": "support@acme.test" },
      workflowId, confirm: true, successCriteria: ["Notify support."],
    })

    // No second workflow: the draft that raised the questions is re-planned.
    expect(vi.mocked(apiPost).mock.calls.filter(([path]) => path === "/api/v1/workflows")).toHaveLength(0)
    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}/actions/plan`,
      { goal: "Triage support mail", answers: { "Which inbox?": "support@acme.test" }, confirm: true, successCriteria: ["Notify support."] },
      expect.anything(),
    )
  })

  it("creates a draft only on the first plan", async () => {
    vi.mocked(apiGet).mockResolvedValue({ id: workflowId, name: "Triage", status: "draft" })
    vi.mocked(apiPost).mockImplementation(async (path: string) =>
      path === "/api/v1/workflows"
        ? ({ id: workflowId, name: "Triage", status: "draft" } as never)
        : ({ type: "plan", successCriteria: [], steps: [{ key: "work", type: "llm", description: "Triage", successCriteria: [] }] } as never),
    )

    await api.compileWorkflow({ goal: "Triage support mail", answers: {} })

    expect(vi.mocked(apiPost).mock.calls.filter(([path]) => path === "/api/v1/workflows")).toHaveLength(1)
  })
  it("accepts explicit removal of every criterion and rejects unconfirmed compilation", async () => {
    vi.mocked(apiGet).mockResolvedValue({ id: workflowId, name: "Triage", status: "draft" })
    vi.mocked(apiPost).mockResolvedValue({ type: "compiled", versionId: "wfv_1" })
    await expect(api.compileWorkflow({ goal: "Triage", answers: {}, workflowId })).rejects.toThrow("Planner compiled before Build confirmation.")
    await api.compileWorkflow({ goal: "Triage", answers: {}, workflowId, confirm: true, successCriteria: [] })
    expect(apiPost).toHaveBeenLastCalledWith(`/api/v1/workflows/${workflowId}/actions/plan`, { goal: "Triage", answers: {}, confirm: true, successCriteria: [] }, expect.anything())
  })

})

describe("project clarifications", () => {
  it("reads the questions the engine has open", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      data: [{ clarification_id: clarificationId, question: "Which framework?", options: [], required: true }],
    })

    expect(await getProjectClarifications(projectId)).toEqual([
      { id: clarificationId, question: "Which framework?", required: true },
    ])
    expect(apiGet).toHaveBeenCalledWith(`/api/v1/projects/${projectId}/clarifications`)
  })

  it("answers one through its own route", async () => {
    vi.mocked(apiPost).mockResolvedValue({})

    await answerProjectClarification(projectId, clarificationId, "React")

    expect(apiPost).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
      { answer: "React" },
      { idempotencyKey: "project-clarification-answer-test-key" },
    )
  })

  it("answers every question, then reports what is still open", async () => {
    const second = "clr_018f47a5-7b2c-7d10-8f11-123456789abd"
    vi.mocked(apiPost).mockResolvedValue({})
    vi.mocked(apiGet).mockResolvedValue({
      data: [{ clarification_id: second, question: "Who hosts it?", options: [], required: true }],
    })

    const remaining = await api.answerProjectClarifications(projectId, {
      [clarificationId]: "React",
    })

    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(remaining).toEqual([{ id: second, question: "Who hosts it?", required: true }])
  })

  it("carries the real project id out of a brief, so the project can be opened", async () => {
    vi.mocked(apiPost).mockResolvedValue({ id: projectId, name: "Portal", status: "draft" })
    vi.mocked(apiGet).mockResolvedValue({ data: [] })

    const result = await api.compileProjectBrief({ goal: "Build a customer portal" })

    expect(result.projectId).toBe(projectId)
    expect(result.clarifications).toEqual([])
  })
})

describe("a workflow plan that needs connections", () => {
  const batch = { type: "connections_required", missing_connections: [
    { connector_type: "github", node_keys: ["fetch", "publish"], reason: "missing" },
    { connector_type: "slack", node_keys: ["notify"], reason: "unavailable" },
  ] }
  it("returns the complete batch without claiming compilation or fetching another draft", async () => {
    vi.mocked(apiGet).mockResolvedValue({ id: workflowId, name: "Triage", status: "draft" })
    vi.mocked(apiPost).mockResolvedValue(batch)
    const result = await api.compileWorkflow({ goal: "Triage support mail", answers: { inbox: "support" }, workflowId })
    expect(result.missingConnections).toEqual(batch.missing_connections)
    expect(result.questions).toEqual([])
    expect(result.explanation).not.toContain("successfully")
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiPost).toHaveBeenCalledWith(`/api/v1/workflows/${workflowId}/actions/plan`, { goal: "Triage support mail", answers: { inbox: "support" } }, expect.anything())
  })
  it("refuses an invalid batch or unrecognized plan result", async () => {
    vi.mocked(apiGet).mockResolvedValue({ id: workflowId, name: "Triage", status: "draft" })
    vi.mocked(apiPost).mockResolvedValue({ ...batch, missing_connections: [] })
    await expect(api.compileWorkflow({ goal: "Triage", answers: {}, workflowId })).rejects.toThrow()
    vi.mocked(apiPost).mockResolvedValue({ type: "unknown" })
    await expect(api.compileWorkflow({ goal: "Triage", answers: {}, workflowId })).rejects.toThrow("Planner did not return a compiled workflow.")
  })
})
