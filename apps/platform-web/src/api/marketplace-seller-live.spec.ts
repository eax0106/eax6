import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async original => ({ ...await original<typeof import("./http")>(), isLiveApi: true }))
import { sellerService } from "./services/seller"

const fetchMock = vi.fn<typeof fetch>()
const resource = {
  resource_type: "listing", id: "lst_review", tenant_id: null, name: "CRM mapping",
  description: "Saved mapping", status: "needs_changes", trust_level: null,
  updated_at: "2026-10-05T00:00:00.000Z", etag: '"revision-1"', review_notes: [],
}
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock) })
afterEach(() => vi.unstubAllGlobals())

describe("live seller review transport", () => {
  it("reads server notes, saves actual fields, then resubmits with the returned revision", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(resource))
      .mockResolvedValueOnce(Response.json({ ...resource, name: "Corrected mapping", etag: '"revision-2"' }))
      .mockResolvedValueOnce(Response.json({ ...resource, name: "Corrected mapping", status: "submitted", etag: '"revision-3"' }))
    const before = await sellerService.listings.review(resource.id)
    const edited = await sellerService.listings.update(resource.id, { title: " Corrected mapping ", description: "Actual field mapping", reason: " Corrected fields ", etag: before.etag })
    const submitted = await sellerService.listings.resubmit(resource.id, " Ready for review ", edited.etag)
    const [, edit] = fetchMock.mock.calls[1]!
    expect(edit?.method).toBe("PATCH")
    expect(edit?.credentials).toBe("include")
    expect(JSON.parse(String(edit?.body))).toEqual({ name: "Corrected mapping", description: "Actual field mapping", reason: "Corrected fields" })
    expect(new Headers(edit?.headers).get("if-match")).toBe('"revision-1"')
    const [url, resubmit] = fetchMock.mock.calls[2]!
    expect(String(url)).toContain("/publisher/reviews/listing/lst_review/actions/resubmit")
    expect(JSON.parse(String(resubmit?.body))).toEqual({ reason: "Ready for review" })
    expect(new Headers(resubmit?.headers).get("if-match")).toBe('"revision-2"')
    expect(submitted.status).toBe("submitted")
  })

  it("rejects missing revisions and invalid reasons before any request", async () => {
    await expect(sellerService.listings.update(resource.id, { title: "Mapping", description: "", reason: "Corrected" })).rejects.toThrow("Reload")
    await expect(sellerService.listings.resubmit(resource.id, "Corrected")).rejects.toThrow("Reload")
    for (const reason of ["  ", "x".repeat(1001)]) {
      await expect(sellerService.listings.resubmit(resource.id, reason, resource.etag)).rejects.toThrow("reason")
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("preserves conflicts and audit failures, and rejects malformed success payloads", async () => {
    for (const [status, message] of [[412, "Revision changed"], [503, "Audit unavailable"]] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ detail: message }, { status }))
      await expect(sellerService.listings.resubmit(resource.id, "Corrected", resource.etag)).rejects.toMatchObject({ status, message })
    }
    fetchMock.mockResolvedValueOnce(Response.json({ success: true }))
    await expect(sellerService.listings.review(resource.id)).rejects.toThrow()
  })
})
