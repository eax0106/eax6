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
  it("starts a subscription with the chosen plan and payment method, idempotently", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "sub_1", planId: "plan_pro", status: "created" }, { status: 201 }))
    await billingService.subscribe("plan_pro", "token_abc")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/billing/subscription")
    expect(init!.method).toBe("POST")
    expect(JSON.parse(String(init!.body))).toEqual({ plan_id: "plan_pro", payment_method_ref: "token_abc" })
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^billing-subscribe/)
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
