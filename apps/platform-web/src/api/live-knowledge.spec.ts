import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { api } from "./client"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe("live knowledge documents", () => {
  it("lists one source's documents from the real route, titled where a title exists", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { id: "doc_1", source_id: "src_1", kind: "file", title: "Refund policy", status: "active", current_version: 2, created_at: "2026-09-28T10:00:00Z", updated_at: "2026-09-28T11:00:00Z" },
          { id: "doc_2", source_id: "src_1", kind: "file", title: null, status: "failed", current_version: 1, created_at: "2026-09-28T09:00:00Z", updated_at: "2026-09-28T09:00:00Z" },
        ],
        page: { next_cursor: null, has_more: false },
      }),
    )

    const documents = await api.getKnowledgeDocuments("src_1")

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/ads/documents?limit=200&sourceId=src_1")
    expect(documents).toEqual([
      { id: "doc_1", sourceId: "src_1", name: "Refund policy", status: "indexed", createdAt: "2026-09-28T10:00:00Z", indexedAt: "2026-09-28T11:00:00Z" },
      { id: "doc_2", sourceId: "src_1", name: "doc_2", status: "failed", createdAt: "2026-09-28T09:00:00Z" },
    ])
  })

  it("deletes a source through the real route with an idempotency key", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await api.deleteKnowledgeSource("src_1")

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/ads/sources/src_1")
    expect(init?.method).toBe("DELETE")
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^knowledge-source-delete-/)
  })
})
