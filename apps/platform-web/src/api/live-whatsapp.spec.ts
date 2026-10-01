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
  it("reads templates and sends the entered recipient, exact template language and stable request key", async () => {
    const templates = [{ name: "hello", language: "fr_FR", status: "APPROVED" }]
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(templates), { status: 200 }))
    await expect(api.getWhatsAppTemplates("wac_1/extra")).resolves.toEqual(templates)
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/accounts/wac_1%2Fextra/templates")

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "wamid.accepted" }), { status: 201 }))
    await expect(api.testWhatsAppChannel("wac_1/extra", { to: "15551234567", templateName: "hello", languageCode: "fr_FR" }, "whatsapp-stable-request"))
      .resolves.toEqual({ messageId: "wamid.accepted" })
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toContain("/accounts/wac_1%2Fextra/test-send")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({ to: "15551234567", templateName: "hello", languageCode: "fr_FR" })
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("whatsapp-stable-request")
  })

  it("surfaces a rejected send instead of reporting success", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: "Template needs parameters" }), { status: 400 }))
    await expect(api.testWhatsAppChannel("wac_1", { to: "15551234567", templateName: "hello", languageCode: "fr_FR" }, "whatsapp-error-request"))
      .rejects.toThrow("Template needs parameters")
  })

  it("deletes an account through the real route with an idempotency key", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await api.deleteWhatsAppChannel("wac_1")

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain("/api/v1/channels/whatsapp/accounts/wac_1")
    expect(init?.method).toBe("DELETE")
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^whatsapp-channel-delete-/)
  })
})
