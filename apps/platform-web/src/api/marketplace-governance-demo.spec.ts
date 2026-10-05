import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("./http", async original => ({ ...await original<typeof import("./http")>(), isLiveApi: false }))
import { demoGovernance } from "./mock/marketplace-governance"
import { sellerService } from "./services/seller"
import { MarketplaceAdminService } from "./services/marketplace-admin"

const id = "lst_demo_changes"
const original = structuredClone(demoGovernance.get(id)!)
afterEach(() => demoGovernance.set(id, structuredClone(original)))

describe("shared reviewer and seller demo state", () => {
  it("retains edits, reviewer reasons and resubmission across both adapters", async () => {
    const admin = new MarketplaceAdminService()
    const before = await sellerService.listings.review(id)
    expect(before.review_notes?.[0]?.reason).toContain("CRM field mapping")
    const edited = await sellerService.listings.update(id, { title: "Corrected CRM", description: "Saved corrected mapping", reason: "Fields corrected", etag: before.etag })
    await expect(sellerService.listings.resubmit(id, "Ready", before.etag)).rejects.toThrow("changed")
    const submitted = await sellerService.listings.resubmit(id, "Ready", edited.etag)
    const queued = (await admin.reviewQueue()).find(item => item.id === id)!
    expect(queued).toMatchObject({ listingName: "Corrected CRM", status: "pending_review", etag: submitted.etag })
    expect(queued.reviewNotes?.map(note => note.action)).toEqual(["resubmit", "edit", "needs_changes"])
    await admin.reviewListing(id, "changes_requested", "Include field types", "listing", queued.etag)
    expect(await sellerService.listings.review(id)).toMatchObject({ status: "needs_changes", description: "Saved corrected mapping", review_notes: [expect.objectContaining({ actor_type: "staff", reason: "Include field types" }), ...submitted.review_notes!] })
    const detached = await sellerService.listings.review(id)
    detached.name = "Client mutation"
    expect((await sellerService.listings.review(id)).name).toBe("Corrected CRM")
  })

  it("requires seller resubmission before approval", async () => {
    await expect(new MarketplaceAdminService().reviewListing(id, "approve", "Reviewed", "listing", original.etag)).rejects.toThrow("resubmit")
    expect((await sellerService.listings.review(id)).status).toBe("needs_changes")
  })
})
