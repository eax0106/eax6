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

describe("live profile and sessions", () => {
  it("saves the display name through the real route and shows no demo job title", async () => {
    fetchMock.mockResolvedValue(Response.json({ userId: "u1", tenantId: "t1", email: "ada@acme.test", name: "Ada L" }))

    const profile = await api.updateProfile({ name: "Ada L", jobTitle: "ignored" })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/auth/me")
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Ada L" })
    expect(profile).toMatchObject({ id: "u1", email: "ada@acme.test", name: "Ada L" })
    expect(profile.jobTitle).toBeUndefined()
  })

  it("signs out other sessions through the real route", async () => {
    fetchMock.mockResolvedValue(Response.json({ revoked: 2 }))

    await api.revokeOtherSessions()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/auth\/sessions$/)
    expect(init?.method).toBe("DELETE")
  })
})
