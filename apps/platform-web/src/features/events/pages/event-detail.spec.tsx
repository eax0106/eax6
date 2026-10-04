import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

vi.mock("@/api/http", async importOriginal => ({ ...await importOriginal<typeof import("@/api/http")>(), isLiveApi: true }))
import { installLiveWorkspaceSession, clearLiveWorkspaceSession } from "@/features/permissions/testing/session"
import { EventDetail } from "./event-detail"

const event = { event_id: "evt_fixture", event_type: "order.received", received_at: "2026-10-01T00:00:00Z", workflow_id: "wf_fixture", payload_inline: { order: "stored-17" } }
const preview = { mode: "dry_run", eventId: event.event_id, workflowId: event.workflow_id, workflowVersionId: "wfv_fixture", payload: event.payload_inline,
  trace: [{ key: "receive", type: "Merge", status: "simulated", input: event.payload_inline }],
  actions: [{ nodeKey: "notify", toolName: "email.send" }, { nodeKey: "update", toolName: "database.update" }], confirmationToken: "a".repeat(64) }
let fail = false
const fetcher = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(
  url.endsWith("/replay-for-real") ? fail ? { detail: "Preview changed; confirm again" } : { runId: "run_replayed", replayedFrom: event.event_id }
    : url.endsWith("/replay") ? preview : event),
{ status: url.endsWith("/replay-for-real") && fail ? 409 : 200, headers: { "content-type": "application/json" } }))

beforeEach(() => { installLiveWorkspaceSession(); fail = false; fetcher.mockClear(); vi.stubGlobal("fetch", fetcher) })
afterEach(() => { cleanup(); clearLiveWorkspaceSession(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function mount() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={[`/events/${event.event_id}`]}><Routes><Route path="/events/:eventId" element={<EventDetail />} /></Routes></MemoryRouter>
  </QueryClientProvider>)
}
describe("EventDetail stored replay", () => {
  it("defaults to dry simulation, displays stored payload and trace, and cancels real actions without posting", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    mount(); await screen.findByText("order.received")
    expect(screen.queryByText(/stored-17/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Replay for real" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Replay (dry run)" }))
    await screen.findByText("receive: Merge (simulated)")
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/replay-for-real"))).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Replay for real" }))
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/2 outside action.*notify: email.send.*update: database.update/s))
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/replay-for-real"))).toHaveLength(0)
  })

  it("confirmed replay posts the preview token once and links to the actual new run", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    mount(); await screen.findByText("order.received")
    fireEvent.click(screen.getByRole("button", { name: "Replay (dry run)" }))
    await screen.findByText("receive: Merge (simulated)")
    fireEvent.click(screen.getByRole("button", { name: "Replay for real" }))
    const link = await screen.findByRole("link", { name: "View replay run" })
    expect(link.getAttribute("href")).toBe("/app/runs/run_replayed")
    const calls = fetcher.mock.calls.filter(([url]) => url.endsWith("/replay-for-real"))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ confirmed: true, confirmationToken: preview.confirmationToken })
    expect(new Headers(calls[0]?.[1]?.headers).get("Idempotency-Key")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Replay for real" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows replay rejection and keeps the same request key when retrying the same confirmation", async () => {
    fail = true; vi.spyOn(window, "confirm").mockReturnValue(true)
    mount(); await screen.findByText("order.received")
    fireEvent.click(screen.getByRole("button", { name: "Replay (dry run)" }))
    await screen.findByText("receive: Merge (simulated)")
    fireEvent.click(screen.getByRole("button", { name: "Replay for real" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Preview changed")
    fireEvent.click(screen.getByRole("button", { name: "Replay for real" }))
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/replay-for-real"))).toHaveLength(2))
    const keys = fetcher.mock.calls.filter(([url]) => url.endsWith("/replay-for-real")).map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"))
    expect(keys[0]).toBe(keys[1])
  })
})
