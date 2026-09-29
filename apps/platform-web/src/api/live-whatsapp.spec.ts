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

describe("live WhatsApp channels", () => {
  it("deletes an account through the real route with an idempotency key", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await api.deleteWhatsAppChannel("wac_1")

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/channels/whatsapp/accounts/wac_1")
    expect(init?.method).toBe("DELETE")
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^whatsapp-channel-delete-/)
  })
})
