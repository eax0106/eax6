import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { billingService } from "./services/billing"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe("live billing (B2.7, B2.8)", () => {
  it("starts hosted checkout with the reviewed plan version and GSTIN, idempotently", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "sub_1", planId: "plan_pro", status: "created" }, { status: 201 }))
    await billingService.subscribe("pro", "2026-10-05T00:00:00.000Z","27ABCDE1234F1Z5")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/billing/subscription")
    expect(init!.method).toBe("POST")
    expect(JSON.parse(String(init!.body))).toEqual({plan_id:"pro",plan_version:"2026-10-05T00:00:00.000Z",gstin:"27ABCDE1234F1Z5"})
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^billing-subscribe/)
  })

  it("retains the displayed ETag for change and cancellation without refreshing away a stale version",async()=>{
    fetchMock.mockImplementation(async()=>Response.json({id:"sub_1",version:"original"},{headers:{ETag:'"displayed"'}}))
    const current=await billingService.getSubscription()
    expect(current?.etag).toBe('"displayed"')
    await billingService.changePlan("pro","2026-10-05T00:00:00.000Z",current?.etag)
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("If-Match")).toBe('"displayed"')
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({plan_id:"pro",plan_version:"2026-10-05T00:00:00.000Z"})
    await billingService.cancelSubscription(current?.etag)
    expect(fetchMock.mock.calls[2]![1]?.method).toBe("DELETE")
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get("If-Match")).toBe('"displayed"')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(billingService.cancelSubscription(undefined)).rejects.toThrow("Refresh the current subscription")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("passes the provider's hosted invoice link through", async () => {
    fetchMock.mockResolvedValue(Response.json({
      items: [{ id: "inv_1", subscriptionId: "sub_1", status: "paid", amount: 4900, currency: "INR", issuedAt: "x", paidAt: null, documentUrl: "https://rzp.io/i/abc" }],
      nextCursor: null,
    }))
    const [invoice] = await billingService.getInvoices()
    expect(invoice!.documentUrl).toBe("https://rzp.io/i/abc")
  })
})
