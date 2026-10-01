import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { getRunRetention, previewRunRetention, setRunRetention } from "./live-run-retention"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe("live run-history retention (D2)", () => {
  it("reads the setting with its ETag", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ retention_days: 365, is_default: true, updated_at: null, etag: '"body"' }, { headers: { ETag: '"wire"' } }),
    )
    await expect(getRunRetention()).resolves.toEqual({ retentionDays: 365, isDefault: true, updatedAt: null, etag: '"wire"' })
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/run-retention")
  })

  it("previews a lower window's deletions", async () => {
    fetchMock.mockImplementation(async () => Response.json({ retention_days: 30, runs_to_delete: 12 }))
    await expect(previewRunRetention(30)).resolves.toBe(12)
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/run-retention/preview?retention_days=30")
  })

  it("saves with If-Match and the confirmation flag, and surfaces a refusal", async () => {
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ retention_days: 30, is_default: false, updated_at: "2026-10-01T00:00:00.000Z", etag: '"after"' }),
    )
    await expect(setRunRetention(30, true, '"before"')).resolves.toMatchObject({ retentionDays: 30, etag: '"after"' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init!.method).toBe("PUT")
    expect(new Headers(init!.headers).get("If-Match")).toBe('"before"')
    expect(JSON.parse(String(init!.body))).toEqual({ retention_days: 30, confirm_lowering: true })

    fetchMock.mockImplementationOnce(async () =>
      Response.json({ title: "Conflict", status: 409, detail: "confirm to continue" }, { status: 409 }),
    )
    await expect(setRunRetention(7, false, '"after"')).rejects.toMatchObject({ status: 409 })
  })
})
