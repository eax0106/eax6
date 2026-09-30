import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { budgetsService } from "./services/usage"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const apiBudget = {
  id: "bud_1", workspace_id: "ws_1", workflow_id: null, kind: "workspace", period: "monthly", currency: "INR",
  amount_minor: 50_000, mode: "hard", enabled: true, spent_minor: 12_345, reserved_minor: 500,
  created_by: "usr_1", created_at: "x", updated_at: "2026-09-30T00:00:00.000Z",
}

describe("live budgets (D3, engine budgets relayed by platform-api)", () => {
  it("reads paise as rupees, and a per-run cap has no spend", async () => {
    fetchMock.mockImplementation(async () => Response.json([apiBudget, { ...apiBudget, id: "bud_2", kind: "run_cap", workflow_id: "wf_1", period: null, spent_minor: null, reserved_minor: null }]))
    const [workspace, cap] = await budgetsService.list()
    expect(workspace).toMatchObject({ kind: "workspace", amount: 500, currentSpend: 123.45, reserved: 5, mode: "hard", period: "monthly" })
    expect(cap).toMatchObject({ kind: "run_cap", workflowId: "wf_1", period: null, currentSpend: null })
  })

  it("creates each kind in the engine's shape, with an idempotency key, and refuses a zero limit locally", async () => {
    fetchMock.mockImplementation(async () => Response.json(apiBudget, { status: 201 }))
    await budgetsService.create({ kind: "workflow", workflowId: "wf_1", period: "daily", amount: 500.1, mode: "warn" })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/budgets")
    expect(JSON.parse(String(init!.body))).toEqual({ kind: "workflow", workflow_id: "wf_1", period: "daily", amount_minor: 50010, mode: "warn" })
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^budget-create/)
    await budgetsService.create({ kind: "workspace", amount: 10, mode: "hard" })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ kind: "workspace", amount_minor: 1000, mode: "hard" })
    await expect(budgetsService.create({ kind: "workspace", amount: 0, mode: "hard" })).rejects.toThrow(/greater than zero/)
    await expect(budgetsService.create({ kind: "run_cap", amount: 5, mode: "hard" })).rejects.toThrow(/workflow/)
  })

  it("updates with If-Match from the budget it read, and deletes by id", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json([apiBudget]))
    const [budget] = await budgetsService.list()
    fetchMock.mockImplementationOnce(async () => Response.json({ ...apiBudget, enabled: false }))
    await budgetsService.update({ ...budget!, id: "bud_1" }, { enabled: false })
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toContain("/api/v1/budgets/bud_1")
    expect(new Headers(init!.headers).get("If-Match")).toBe("2026-09-30T00:00:00.000Z")
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 204 }))
    await budgetsService.remove("bud_1")
    expect(String(fetchMock.mock.calls[2]![0])).toContain("/api/v1/budgets/bud_1")
  })
})
