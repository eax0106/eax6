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

describe("live artifacts list", () => {
  it("reads the workspace's artifacts from the real route, not the demo list", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { id: "art_1", runId: "run_1", workspaceId: "w", contentType: "text/csv", sizeBytes: 42, createdAt: "2026-09-29T10:00:00Z" },
        ],
        page: { next_cursor: null, has_more: false },
      }),
    )

    const artifacts = await api.getArtifacts()

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/artifacts?limit=200")
    expect(artifacts).toEqual([
      expect.objectContaining({ id: "art_1", runId: "run_1", mimeType: "text/csv", sizeBytes: 42, createdAt: "2026-09-29T10:00:00Z" }),
    ])
  })
})
