import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { getMonthToDateUsage } from "./live-usage"
import { LiveCostBreakdown } from "@/features/money/components/live-usage"
import { costEstimatesService } from "./services/usage"

const summary = {
  startAt: "2026-09-01T00:00:00.000Z",
  endAt: "2026-09-28T12:00:00.000Z",
  currency: "INR",
  dimensions: ["source", "provider", "resource"],
  groups: [
    { dimensions: { source: "tool_gateway", provider: "tavily", resource: "search" }, internalCostMinor: "90", retryCostMinor: "0", recoveryCostMinor: "0", billableMinor: "120", marginMinor: "30", eventCount: 4 },
    { dimensions: { source: "model_gateway", provider: "bedrock", resource: "nova-micro" }, internalCostMinor: "700", retryCostMinor: "0", recoveryCostMinor: "0", billableMinor: "1000", marginMinor: "300", eventCount: 10 },
  ],
  totals: { internalCostMinor: "790", billableMinor: "1120", marginMinor: "330" },
}

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("live usage (B2.9)", () => {
  it("asks the cost ledger for this month by source, provider and resource and keeps billable spend only", async () => {
    fetchMock.mockResolvedValue(Response.json(summary))
    const usage = await getMonthToDateUsage(new Date("2026-09-28T12:00:00.000Z"))
    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://x")
    expect(url.pathname).toBe("/api/v1/costs/summary")
    expect(url.searchParams.get("startAt")).toBe("2026-09-01T00:00:00.000Z")
    expect(url.searchParams.getAll("dimensions")).toEqual(["source", "provider", "resource"])
    expect(usage.billableMinor).toBe(1120)
    expect(usage.events).toBe(14)
    expect(usage.lines.map((l) => [l.provider, l.billableMinor])).toEqual([["bedrock", 1000], ["tavily", 120]])
    expect(JSON.stringify(usage)).not.toMatch(/margin|internal/i)
  })

  it("refuses a malformed amount instead of showing a wrong figure", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...summary, totals: { billableMinor: "-5" } }))
    await expect(getMonthToDateUsage()).rejects.toThrow(/Invalid cost amount/)
  })

  it("shows the customer the billable spend, never the ledger's internal cost", async () => {
    fetchMock.mockResolvedValue(Response.json(summary))
    render(<QueryClientProvider client={new QueryClient()}><LiveCostBreakdown /></QueryClientProvider>)
    expect(await screen.findByText("nova-micro")).toBeTruthy()
    expect(screen.getByText("₹10.00")).toBeTruthy()
    expect(screen.queryByText("₹7.00")).toBeNull()
  })

  it("shows no workflow estimate in live mode rather than a made-up one", async () => {
    await expect(costEstimatesService.forWorkflow("wf_1")).resolves.toBeNull()
  })
})
