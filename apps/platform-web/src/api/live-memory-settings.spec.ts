import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (original) => ({
  ...(await original<typeof import("./http")>()), isLiveApi: true,
}))
import { api } from "./client"

const fetchMock = vi.fn<typeof fetch>()
const settings = {
  conversationMemoryEnabled: true, workflowMemoryEnabled: true,
  workspaceMemoryEnabled: true, retentionDays: 90, etag: '"memory-0"',
}
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock) })
afterEach(() => vi.unstubAllGlobals())

describe("live workspace memory settings", () => {
  it("reads actual workspace settings and preserves the server ETag", async () => {
    fetchMock.mockResolvedValue(Response.json(settings, { headers: { ETag: settings.etag } }))
    const result = await api.getMemoryConfiguration()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/v1\/memory-settings$/)
    expect(result).toEqual(settings)
  })
  it("writes only the three switches and retention, using the pinned If-Match", async () => {
    const next = { ...settings, conversationMemoryEnabled: false, etag: '"memory-1"' }
    fetchMock.mockResolvedValue(Response.json(next))
    const result = await api.updateMemoryConfiguration({ ...settings, conversationMemoryEnabled: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/memory-settings$/)
    expect(init?.method).toBe("PUT")
    expect(new Headers(init?.headers).get("If-Match")).toBe(settings.etag)
    expect(JSON.parse(String(init?.body))).toEqual({
      conversationMemoryEnabled: false, workflowMemoryEnabled: true,
      workspaceMemoryEnabled: true, retentionDays: 90,
    })
    expect(result).toEqual(next)
  })
  it("propagates a stale-write conflict instead of returning demo settings", async () => {
    fetchMock.mockResolvedValue(Response.json({ code: "MEMORY_SETTINGS_STALE", message: "Reload memory settings" }, { status: 412 }))
    await expect(api.updateMemoryConfiguration(settings)).rejects.toMatchObject({ status: 412 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
