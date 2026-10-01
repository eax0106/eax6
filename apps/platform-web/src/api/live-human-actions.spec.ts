import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  mutationKey: (prefix: string) => `${prefix}-test-key`,
}))

import { apiGet, apiPost } from "./http"
import { answerHumanAction, getHumanAction, getHumanActions } from "./live"
import type { HumanActionFilters } from "./types"

// One page per source lifecycle, shaped as /api/v1/action-centre returns it.
const firstPage = {
  data: [
    { source_type: "approval", item: { id: "apr_pending", status: "pending" } },
    { source_type: "escalation", item: { id: "esc_open", status: "open" } },
    { source_type: "clarification", item: { id: "clr_open", status: "open" } },
    { source_type: "escalation", item: { id: "esc_claimed", status: "claimed" } },
  ],
  page: { next_cursor: "next-1", has_more: true, limit: 200 },
}
const secondPage = {
  data: [
    { source_type: "approval", item: { id: "apr_approved", status: "approved" } },
    { source_type: "approval", item: { id: "apr_expired", status: "expired" } },
    { source_type: "escalation", item: { id: "esc_resolved", status: "resolved" } },
    { source_type: "clarification", item: { id: "clr_answered", status: "answered" } },
  ],
  page: { next_cursor: null, has_more: false, limit: 200 },
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path.includes("cursor=next-1") ? secondPage : firstPage,
  )
})

async function ids(filters?: HumanActionFilters) {
  return (await getHumanActions(filters)).map((action) => action.id)
}

describe("One human action", () => {
  it("shows the recovery question and answers through the run-scoped clarification route", async () => {
    const item = { id: "clr_recovery", status: "open", run_id: "run_recovery", node_execution_id: "node_action",
      description: "The outcome is uncertain. Check the external system; Alter will not retry or swap this step." }
    vi.mocked(apiGet).mockResolvedValue({ source_type: "clarification", item })
    expect(await getHumanAction(item.id)).toMatchObject({ type: "clarification", runId: item.run_id, description: item.description })
    vi.mocked(apiPost).mockResolvedValue({ ...item, status: "answered", answer: "Checked external system" })
    expect(await answerHumanAction(item.id, { comment: "Checked external system" })).toMatchObject({ type: "clarification", status: "answered", runId: item.run_id })
    expect(apiPost).toHaveBeenCalledWith("/api/v1/runs/run_recovery/clarifications/clr_recovery/answer", { note: "Checked external system" })
  })

  it("is read by its own id, not by loading the queue and searching it", async () => {
    const item = { source_type: "escalation", item: { id: "esc_1", status: "claimed" } }
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiGet).mockResolvedValue(item)

    const action = await getHumanAction("esc_1")

    expect(action).toMatchObject({ id: "esc_1", type: "escalation", status: "claimed" })
    expect(vi.mocked(apiGet).mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/action-centre/esc_1",
    ])
  })
})

describe("Human Actions tabs over approvals, escalations and clarifications", () => {
  it("never sends the tab to the action centre, whose status filter is approvals-only", async () => {
    await ids({ status: "open" })

    expect(vi.mocked(apiGet).mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/action-centre?limit=200",
      "/api/v1/action-centre?limit=200&cursor=next-1",
    ])
  })

  it("shows pending approvals with open escalations and clarifications under Open", async () => {
    expect(await ids({ status: "open" })).toEqual(["apr_pending", "esc_open", "clr_open"])
  })

  it("shows claimed escalations under Claimed", async () => {
    expect(await ids({ status: "claimed" })).toEqual(["esc_claimed"])
  })

  it("shows decided, expired, resolved and answered items under Resolved", async () => {
    expect(await ids({ status: "resolved" })).toEqual([
      "apr_approved",
      "apr_expired",
      "esc_resolved",
      "clr_answered",
    ])
  })

  it("shows everything under All, and still filters by type", async () => {
    expect(await ids({ status: "all" })).toHaveLength(8)
    expect(await ids({ status: "all", type: "approval" })).toEqual([
      "apr_pending",
      "apr_approved",
      "apr_expired",
    ])
  })
})
