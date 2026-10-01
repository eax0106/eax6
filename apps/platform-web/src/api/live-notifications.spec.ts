import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { notificationsService } from "./services/notifications"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const event = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, tenantId: "t", workspaceId: "w", eventClass: "approval", severity: "warning", title: "Approval needed",
  body: "Refund needs a decision", deepLink: "/app/human-actions/act_1", createdAt: "2026-09-28T00:00:00.000Z",
  sourceService: "platform-api", readAt: null, acknowledgedAt: null, ...overrides,
})

describe("live notifications (B3.1)", () => {
  it("maps API events onto the console's categories, status and priority, and keeps only in-app links", async () => {
    fetchMock.mockResolvedValue(Response.json({ items: [
      event("evt_1"),
      event("evt_2", { eventClass: "budget", severity: "info", readAt: "x", deepLink: "https://evil.example/phish" }),
      event("evt_3", { eventClass: "deployment", severity: "critical" }),
    ], nextCursor: null }))
    const list = await notificationsService.list()
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/notifications?limit=100")
    expect(list.map((n) => [n.type, n.status, n.priority, n.url])).toEqual([
      ["human_action", "unread", "high", "/app/human-actions/act_1"],
      ["billing", "read", "normal", undefined],
      ["deployment", "unread", "high", "/app/human-actions/act_1"],
    ])
  })

  it("keeps approval in-app delivery on even when an old preference or client input disables it", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([
      { eventClass: "approval", channel: "in_app", enabled: false },
      { eventClass: "approval", channel: "email", enabled: false },
    ]))
    expect((await notificationsService.getPreferences()).find(p => p.category === "human_action"))
      .toEqual({ category: "human_action", inApp: true, email: false })
    fetchMock.mockResolvedValueOnce(Response.json([]))
    await notificationsService.updatePreferences([{ category: "human_action", inApp: false, email: false }])
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ preferences: [
      { event_class: "approval", channel: "in_app", enabled: true },
      { event_class: "approval", channel: "email", enabled: false },
    ] })
  })

  it("marks every unread notification read one by one", async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes("read=false") ? Response.json({ items: [event("evt_1"), event("evt_2")], nextCursor: null }) : new Response(null, { status: 204 }),
    )
    await notificationsService.markAllRead()
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url))
    expect(posts).toEqual([
      expect.stringContaining("/api/v1/notifications/evt_1/actions/read"),
      expect.stringContaining("/api/v1/notifications/evt_2/actions/read"),
    ])
  })

  it("refuses 'mark unread', which the API does not have", async () => {
    await expect(notificationsService.markUnread("evt_1")).rejects.toThrow(/not available/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows both channels on until a preference says otherwise, and saves both channels per category", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([{ eventClass: "budget", channel: "email", enabled: false, deliveryMode: "immediate" }]))
    const preferences = await notificationsService.getPreferences()
    expect(preferences).toHaveLength(6)
    expect(preferences.find((p) => p.category === "billing")).toEqual({ category: "billing", inApp: true, email: false })
    expect(preferences.find((p) => p.category === "human_action")).toEqual({ category: "human_action", inApp: true, email: true })

    fetchMock.mockResolvedValueOnce(Response.json([]))
    await notificationsService.updatePreferences([{ category: "billing", inApp: false, email: true }, { category: "marketplace", inApp: true, email: true }])
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ preferences: [
      { event_class: "budget", channel: "in_app", enabled: false },
      { event_class: "budget", channel: "email", enabled: true },
    ] })
  })
})
