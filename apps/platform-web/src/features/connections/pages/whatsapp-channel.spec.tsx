import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { installLiveWorkspaceSession, clearLiveWorkspaceSession } from "@/features/permissions/testing/session"

vi.mock("@/api/http", async importOriginal => ({ ...await importOriginal<typeof import("@/api/http")>(), isLiveApi: true }))
import { WhatsAppChannelPage } from "./whatsapp-channel"

let rejectSend = false
let withDate = false
const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  void init
  const body = url.endsWith("/test-send") ? rejectSend ? { detail: "Template needs parameters" } : { messageId: "wamid.accepted" }
    : url.endsWith("/templates") ? [
      { name: "hello", language: "fr_FR", status: "APPROVED" },
      { name: "hello", language: "en_US", status: "APPROVED" },
      { name: "draft", language: "en_US", status: "PENDING" },
    ] : [{ id: "wac_fixture", phoneNumberId: "phone-fixture", status: "connected", ...(withDate ? { createdAt: "2026-09-01T00:00:00Z" } : {}) }]
  return new Response(JSON.stringify(body), { status: url.endsWith("/test-send") && rejectSend ? 400 : 200, headers: { "content-type": "application/json" } })
})
function role(value: "owner" | "viewer") {
  act(() => installLiveWorkspaceSession(value))
}
beforeEach(() => { rejectSend = false; withDate = false; role("owner"); fetcher.mockClear(); vi.stubGlobal("fetch", fetcher) })
afterEach(() => { cleanup(); clearLiveWorkspaceSession(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function mount() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <WhatsAppChannelPage />
  </QueryClientProvider>)
}
async function choose() {
  await screen.findAllByText("phone-fixture")
  expect(screen.queryByLabelText("Recipient (international number)")).toBeTruthy()
  const input = await screen.findByLabelText("Recipient (international number)")
  await screen.findByRole("option", { name: "hello (fr_FR)" })
  fireEvent.change(input, { target: { value: "+15551234567" } })
  fireEvent.change(screen.getByLabelText("Approved template"), { target: { value: "hello:fr_FR" } })
}
const sends = () => fetcher.mock.calls.filter(([url]) => url.endsWith("/test-send"))

describe("WhatsApp test-send form", () => {
  it("handles accounts without a date, selects approved language, confirms recipient and displays actual provider acceptance", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    mount(); await choose()
    expect(screen.queryByText(/^Created/)).toBeNull()
    expect(screen.queryByRole("option", { name: "draft (en_US)" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("hello (fr_FR) to +15551234567"))
    expect(sends()).toHaveLength(0)
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }))
    expect((await screen.findByRole("status")).textContent).toBe("Message accepted: wamid.accepted")
    expect(sends()).toHaveLength(1)
    expect(JSON.parse(String(sends()[0]![1]?.body))).toEqual({ to: "15551234567", templateName: "hello", languageCode: "fr_FR" })
    expect((screen.getByRole("button", { name: "Send test message" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("rejects an invalid recipient before confirmation or sending", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    mount(); await choose()
    fireEvent.change(screen.getByLabelText("Recipient (international number)"), { target: { value: "invalid" } })
    fireEvent.submit(screen.getByRole("button", { name: "Send test message" }).closest("form")!)
    expect(confirm).not.toHaveBeenCalled(); expect(sends()).toHaveLength(0)
  })

  it("retains a stable key across failed retries and uses a new key after the recipient changes", async () => {
    rejectSend = true; vi.spyOn(window, "confirm").mockReturnValue(true)
    mount(); await choose()
    const button = screen.getByRole("button", { name: "Send test message" })
    fireEvent.click(button)
    expect((await screen.findByRole("alert")).textContent).toContain("Template needs parameters")
    expect((screen.getByLabelText("Recipient (international number)") as HTMLInputElement).value).toBe("+15551234567")
    fireEvent.click(button)
    await waitFor(() => expect(sends()).toHaveLength(2))
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    const key = new Headers(sends()[0]![1]?.headers).get("Idempotency-Key")
    expect(key).toBeTruthy(); expect(new Headers(sends()[1]![1]?.headers).get("Idempotency-Key")).toBe(key)
    fireEvent.change(screen.getByLabelText("Recipient (international number)"), { target: { value: "+15557654321" } })
    rejectSend = false; fireEvent.click(button)
    await screen.findByRole("status")
    expect(new Headers(sends()[2]![1]?.headers).get("Idempotency-Key")).not.toBe(key)
  })

  it("hides test sending from a read-only viewer without fetching templates", async () => {
    role("viewer"); withDate = true; mount()
    await screen.findByText("WhatsApp Integration")
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    await screen.findAllByText("phone-fixture")
    expect(screen.queryByRole("button", { name: "Send test message" })).toBeNull()
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/templates"))).toBe(false)
  })
})
