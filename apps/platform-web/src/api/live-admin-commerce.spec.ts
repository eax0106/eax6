import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { listBillingIssues, listMarketplaceReviews, reviewMarketplaceItem } from "./live-admin-commerce"
import { BillingOpsService } from "./services/billing-ops"
import { MarketplaceAdminService } from "./services/marketplace-admin"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe("live admin marketplace and billing (B2.1, B2.2)", () => {
  it("shows queued listings and tools as pending and taken-down ones as suspended", async () => {
    const base = { tenant_id: null, trust_level: null, updated_at: "2026-09-28T00:00:00Z" }
    fetchMock.mockResolvedValue(
      Response.json([
        { ...base, resource_type: "listing", id: "lst_1", name: "Scraper", status: "human_review", tenant_id: "7f7c7d1e-0000-4000-8000-000000000001" },
        { ...base, resource_type: "listing", id: "lst_2", name: "Old", status: "suspended" },
        { ...base, resource_type: "tool_manifest", id: "tlm_1", name: "Search", status: "draft", trust_level: "unverified_private" },
        { ...base, resource_type: "tool_manifest", id: "tlm_2", name: "Bad", status: "blocked", trust_level: "blocked" },
      ]),
    )
    const reviews = await listMarketplaceReviews()
    expect(reviews.map((r) => [r.id, r.resourceType, r.status, r.assetType])).toEqual([
      ["lst_1", "listing", "pending_review", "listing"],
      ["lst_2", "listing", "suspended", "listing"],
      ["tlm_1", "tool_manifest", "pending_review", "tool"],
      ["tlm_2", "tool_manifest", "suspended", "tool"],
    ])
    expect(reviews[0]!.sellerName).toBe("7f7c7d1e-0000-4000-8000-000000000001")
    expect(reviews[2]!.trustLevel).toBe("unverified_private")
    expect(reviews[0]!.risk).toBeUndefined()
  })

  it("sends suspend as the governance takedown, on the item's own resource type, with a reason", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ resource_type: "tool_manifest", id: "tlm_1", tenant_id: null, name: "Search", status: "blocked", trust_level: "blocked", updated_at: "x" }),
    )
    const result = await reviewMarketplaceItem({ id: "tlm_1", resourceType: "tool_manifest" }, "suspend")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/admin/marketplace/governance/tool_manifest/tlm_1/actions/apply")
    expect(JSON.parse(String(init!.body))).toEqual({ action: "takedown", reason: "Decided in the admin console" })
    expect(result.status).toBe("suspended")
  })

  it("refuses 'changes requested' in live mode instead of pretending it happened", async () => {
    await expect(new MarketplaceAdminService().reviewListing("lst_1", "changes_requested")).rejects.toThrow(/not available/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("lists tenants out of good standing as open payment failures with their access state and no invented amount", async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        { tenant_id: "ten_a", tenant_name: "Acme", state: "grace", current_plan: "pro", first_failed_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z" },
        { tenant_id: "ten_b", tenant_name: "Beta", state: "suspended", current_plan: null, first_failed_at: null, updated_at: "2026-09-01T00:00:00.000Z" },
      ]),
    )
    const issues = await listBillingIssues()
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/admin/billing/issues")
    expect(issues.map((i) => [i.tenantName, i.issue, i.status, i.accessState, i.plan, i.createdAt])).toEqual([
      ["Acme", "payment_failed", "open", "grace", "pro", "2026-09-20T00:00:00.000Z"],
      ["Beta", "payment_failed", "open", "suspended", "unknown", "2026-09-01T00:00:00.000Z"],
    ])
    expect(issues[0]!.amount).toBeUndefined()
  })

  it("refuses resolve, credit and retry in live mode: they have no backend", async () => {
    const service = new BillingOpsService()
    await expect(service.resolve("ten_a")).rejects.toThrow(/no backend/)
    await expect(service.applyCredit("ten_a", 10, "x")).rejects.toThrow(/no backend/)
    await expect(service.retryBilling("ten_a")).rejects.toThrow(/no backend/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
