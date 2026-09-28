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
  localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

describe("live language preference", () => {
  it("starts a new device in the language the user saved", async () => {
    fetchMock.mockResolvedValue(Response.json({ language: "hi" }))

    await expect(api.getLanguage()).resolves.toBe("hi-IN")

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/i18n/users/me/language")
    expect(localStorage.getItem("alterx_lang")).toBe("hi-IN")
  })

  it("maps the backend default to English", async () => {
    fetchMock.mockResolvedValue(Response.json({ language: "en" }))

    await expect(api.getLanguage()).resolves.toBe("en-US")
  })
})
