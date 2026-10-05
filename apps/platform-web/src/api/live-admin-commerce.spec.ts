import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { listBillingIssues, listMarketplaceReviews, listSellerVerifications, reviewMarketplaceItem, reviewSellerVerification, listToolVersionReviews, reviewToolVersion } from "./live-admin-commerce"
import { BillingOpsService } from "./services/billing-ops"
import { MarketplaceAdminService, type ToolVersionReviewItem } from "./services/marketplace-admin"

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
      Response.json({ resource_type: "tool_manifest", id: "tlm_1", tenant_id: null, name: "Search", status: "blocked", trust_level: "blocked", updated_at: "2026-10-05T00:00:00.000Z" }),
    )
    const result = await reviewMarketplaceItem({ id: "tlm_1", resourceType: "tool_manifest", etag: '"revision-1"' }, "suspend", "Inspected tool")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/admin/marketplace/governance/tool_manifest/tlm_1/actions/apply")
    expect(JSON.parse(String(init!.body))).toEqual({ action: "takedown", reason: "Inspected tool" })
    expect(new Headers(init!.headers).get("if-match")).toBe('"revision-1"')
    expect(result.status).toBe("suspended")
  })

  it("sends requested changes with bounded reviewer reason and the exact revision", async () => {
    const resource={resource_type:"listing",id:"lst_1",tenant_id:null,name:"CRM mapping",status:"needs_changes",trust_level:null,updated_at:"2026-10-05T00:00:00Z",etag:'"revision-2"',
      risk:{score:15,incomplete:true,reasons:[{signal:"scanner",points:0,detail:"No recorded scanner verdict",evidence:[],observed:false}]},
      review_notes:[{id:"mge_1",actor_type:"staff",actor_ref:"stf_review",action:"needs_changes",previous_status:"human_review",next_status:"needs_changes",reason:"Correct mapping",occurred_at:"2026-10-05T00:00:00Z"}]}
    fetchMock.mockResolvedValue(Response.json(resource))
    const item=await new MarketplaceAdminService().reviewListing("lst_1","changes_requested","Correct mapping","listing",'"revision-1"')
    expect(item).toMatchObject({status:"changes_requested",etag:'"revision-2"',riskDetails:resource.risk,reviewNotes:resource.review_notes})
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({action:"needs_changes",reason:"Correct mapping"})
    expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get("if-match")).toBe('"revision-1"')
  })
  it("rejects missing revision or invalid reasons before dispatch and surfaces server conflict",async()=>{
    const service=new MarketplaceAdminService()
    await expect(service.reviewListing("lst_1","changes_requested","Correct mapping")).rejects.toThrow("Reload")
    for(const reason of [" ","x".repeat(1001)])await expect(service.reviewListing("lst_1","changes_requested",reason,"listing",'"rev"')).rejects.toThrow("1 to 1000")
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(Response.json({detail:"The resource changed",error_code:"PRECONDITION_FAILED"},{status:412}))
    await expect(service.reviewListing("lst_1","changes_requested","Correct mapping","listing",'"rev"')).rejects.toThrow()
  })

  it("lists tenants out of good standing as open payment failures with their access state and no invented amount", async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        { tenant_id: "00000000-0000-7000-8000-0000000000a1", etag: '"billing-00000000-0000-7000-8000-0000000000a1-1"', tenant_name: "Acme", state: "grace", current_plan: "pro", first_failed_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z" },
        { tenant_id: "00000000-0000-7000-8000-0000000000b1", etag: '"billing-00000000-0000-7000-8000-0000000000b1-1"', tenant_name: "Beta", state: "suspended", current_plan: null, first_failed_at: null, updated_at: "2026-09-01T00:00:00.000Z" },
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

  it("rejects invalid billing subjects before a live financial operation", async () => {
    const service = new BillingOpsService()
    const item={id:"bad",tenantId:"bad",tenantName:"Bad",issue:"payment_failed" as const,plan:"pro",status:"open" as const,createdAt:"2026-09-20T00:00:00.000Z",etag:'"wrong"'}
    await expect(service.resolve(item,"Investigated")).rejects.toThrow()
    await expect(service.applyCredit(item,10,"Investigated")).rejects.toThrow()
    await expect(service.retryBilling(item,"Investigated")).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("lists seller verifications and sends a rejection with its reason to the submission's tenant", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json([{ id: "kyc_1", tenant_id: "7f7c7d1e-0000-4000-8000-000000000001", publisher_id: "pub_1", documents: [{ type: "tax_id", objectRef: "s3://x/tax" }], submitted_at: "2026-09-28T00:00:00.000Z" }]),
    )
    const [item] = await listSellerVerifications()
    expect(item).toEqual({ id: "kyc_1", tenantId: "7f7c7d1e-0000-4000-8000-000000000001", documents: [{ type: "tax_id", objectRef: "s3://x/tax" }], submittedAt: "2026-09-28T00:00:00.000Z" })

    fetchMock.mockResolvedValueOnce(Response.json({ id: "kyc_1", status: "rejected" }))
    await reviewSellerVerification(item!, "rejected", "Tax ID does not match")
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toContain("/api/v1/admin/publisher/verifications/7f7c7d1e-0000-4000-8000-000000000001/kyc_1/actions/review")
    expect(JSON.parse(String(init!.body))).toEqual({ decision: "rejected", reason: "Tax ID does not match" })
  })
})


describe("live first-tool-version review", () => {
  const item: ToolVersionReviewItem = { manifestId: "tlm_manifest", tenantId: "ten_owner", name: "CRM", version: { id: "tlv_version", manifestId: "tlm_manifest", pinned: false, publishedAt: null, version: "1.0.0", artifactRef: "s3://fixture", capabilities: [], permissions: [], status: "review_pending", scanReportId: "scn_current" }, scan: { id: "scn_current", toolVersionId: "tlv_version", verdict: "clean" as const, findings: [], scannerVersion: "OSV-Scanner v2.6.0", durationMs: 1, scannedAt: "2026-10-04T00:00:00.000Z" } }
  it("loads the exact scan and submits only decision, report and reason using staff cookies", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([item]))
    expect(await listToolVersionReviews()).toEqual([item])
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/governance/tools/review-queue")
    fetchMock.mockResolvedValueOnce(Response.json({ ...item.version, status: "published" }))
    expect((await reviewToolVersion(item, "approved", "  Checked dependencies  ")).status).toBe("published")
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toContain("/governance/tools/tlm_manifest/versions/tlv_version/review")
    expect(JSON.parse(String(init!.body))).toEqual({ scanReportId: "scn_current", decision: "approved", reason: "Checked dependencies" })
    expect(init!.credentials).toBe("include")
  })
  it("propagates an exact-scan conflict instead of reporting publication", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: 409, title: "Conflict", detail: "The scan changed; reload before reviewing" }, { status: 409 }))
    await expect(reviewToolVersion(item, "approved", "Checked")).rejects.toThrow(/scan changed/)
  })
})
