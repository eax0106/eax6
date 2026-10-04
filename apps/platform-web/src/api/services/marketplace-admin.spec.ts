import { describe, expect, it, vi } from "vitest"
vi.mock("../http", async (original) => ({ ...(await original<typeof import("../http")>()), isLiveApi: false }))
import { MarketplaceAdminService } from "./marketplace-admin"

describe("mock tool-version review mirrors live decisions", () => {
  it("requires a reason, binds the exact scan, records staff attribution and keeps identical retries stable", async () => {
    const service = new MarketplaceAdminService(), [item] = await service.toolVersionReviewQueue()
    expect(item!.version.status).toBe("review_pending")
    await expect(service.reviewToolVersion(item!, "approved", " ")).rejects.toThrow(/reason/)
    await expect(service.reviewToolVersion({ ...item!, scan: { ...item!.scan, id: "scn_old" } }, "approved", "Checked")).rejects.toThrow(/scan changed/)
    const result = await service.reviewToolVersion(item!, "approved", "Checked")
    expect(result).toMatchObject({ status: "published", review: { scanReportId: item!.scan.id, reviewedBy: "stf_demo", reason: "Checked" } })
    expect(await service.reviewToolVersion(item!, "approved", "Checked")).toEqual(result)
    await expect(service.reviewToolVersion(item!, "rejected", "Checked")).rejects.toThrow(/different recorded/)
    expect(await service.toolVersionReviewQueue()).toEqual([])
  })
  it("rejects without publishing and returns queue snapshots that cannot change authoritative state", async () => {
    const service = new MarketplaceAdminService(), [item] = await service.toolVersionReviewQueue()
    Object.assign(item!.version, { status: "published" })
    expect((await service.toolVersionReviewQueue())[0]!.version.status).toBe("review_pending")
    const result = await service.reviewToolVersion(item!, "rejected", "Package documentation insufficient")
    expect(result.status).toBe("scan_failed")
    expect(await service.toolVersionReviewQueue()).toEqual([])
  })
})
