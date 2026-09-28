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
  id: "bud_1", name: "Monthly", amountMinor: 50_000, currency: "INR", period: "monthly",
  thresholds: [{ percent: 80, action: "warn" }], enabled: true, currentSpendMinor: 12_345, createdAt: "x", updatedAt: "x",
}

describe("live budgets (B2.9b)", () => {
  it("reads minor units as major units and keeps unknown spend unknown", async () => {
    fetchMock.mockResolvedValue(Response.json([apiBudget, { ...apiBudget, id: "bud_2", currentSpendMinor: null }]))
    const [known, unknown] = await budgetsService.list()
    expect(known).toMatchObject({ amount: 500, currentSpend: 123.45, scope: "workspace", period: "monthly" })
    expect(unknown!.currentSpend).toBeNull()
  })

  it("creates with minor units and an idempotency key, and refuses a zero limit locally", async () => {
    fetchMock.mockResolvedValue(Response.json(apiBudget, { status: 201 }))
    await budgetsService.create({ name: "Monthly", amount: 500.1, currency: "INR", thresholds: [{ percent: 100, action: "block" }] })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/budgets")
    expect(JSON.parse(String(init!.body))).toEqual({ name: "Monthly", amount_minor: 50_010, currency: "INR", thresholds: [{ percent: 100, action: "block" }], enabled: true })
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^budget-create/)
    await expect(budgetsService.create({ name: "x", amount: 0, currency: "INR" })).rejects.toThrow(/greater than zero/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("sends only the changed field on update and deletes by id", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...apiBudget, enabled: false }))
    await budgetsService.update("bud_1", { enabled: false })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ enabled: false })
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await budgetsService.remove("bud_1")
    expect(fetchMock.mock.calls[1]![1]!.method).toBe("DELETE")
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/api/v1/budgets/bud_1")
  })
})
