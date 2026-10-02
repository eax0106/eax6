import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("./http", async original => ({ ...(await original<typeof import("./http")>()), isLiveApi: true }))
import { api } from "./client"

const suffix = "00000000-0000-7000-8000-000000000001"
const chat = { id: `cnv_${suffix}`, title: "Support", type: "workflow_builder" as const, status: "active" as const,
  linkedWorkflowId: `wf_${suffix}`, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }
const user = { id: `msg_${suffix}`, conversationId: chat.id, role: "user", kind: "text", content: "Original goal", createdAt: chat.createdAt }
const assistant = { ...user, id: "msg_00000000-0000-7000-8000-000000000002", role: "assistant", content: { text: "Compiled", versionId: `wfv_${suffix}` } }
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset() })
afterEach(() => vi.unstubAllGlobals())
const path = (index: number) => String(fetchMock.mock.calls[index]![0])
const init = (index: number) => fetchMock.mock.calls[index]![1]!

 describe("live workflow chat", () => {
  it("lists, gets and reads persisted messages through actual HTTP", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([chat])).mockResolvedValueOnce(Response.json(chat)).mockResolvedValueOnce(Response.json([user, assistant]))
    expect(await api.getConversations({ type: "workflow_builder" })).toEqual([chat])
    expect(await api.getConversation(chat.id)).toEqual(chat)
    expect(await api.getConversationMessages(chat.id)).toEqual([user, assistant])
    expect(path(0)).toMatch(/\/api\/v1\/conversations\?type=workflow_builder$/)
    expect(path(1)).toMatch(new RegExp(`/conversations/${chat.id}$`))
    expect(path(2)).toMatch(/\/messages$/)
    expect(fetchMock.mock.calls.every(([, options]) => options?.credentials === "include")).toBe(true)
  })
  it("creates draft/chat atomically through the builder route", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(chat))
    expect(await api.createConversation({ type: "workflow_builder", title: "Support" })).toEqual(chat)
    expect(path(0)).toMatch(/\/conversations\/workflows$/)
    expect(init(0).method).toBe("POST")
    expect(JSON.parse(String(init(0).body))).toEqual({ type: "workflow_builder", title: "Support" })
    expect(new Headers(init(0).headers).get("Idempotency-Key")).toBeTruthy()
  })
  it("uses actual chat type for builder messages and independent archiving", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(chat)).mockResolvedValueOnce(Response.json({ userMessage: user, assistantMessage: assistant }))
      .mockResolvedValueOnce(Response.json(chat)).mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await api.sendMessage(chat.id, { content: "Original goal" })).toEqual({ userMessage: user, assistantMessage: assistant })
    await api.archiveConversation(chat.id)
    expect(path(1)).toMatch(/\/build$/); expect(path(3)).toMatch(/\/workflow-archive$/)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/workflows/"))).toBe(false)
  })
  it("keeps Ask Alter on its assistant route and starts only an explicit empty draft", async () => {
    const ask = { ...chat, type: "general", linkedWorkflowId: undefined }
    fetchMock.mockResolvedValueOnce(Response.json(ask)).mockResolvedValueOnce(Response.json(ask))
      .mockResolvedValueOnce(Response.json({ userMessage: user, assistantMessage: assistant }))
      .mockResolvedValueOnce(Response.json(chat))
    await api.createConversation({ type: "general", title: "Ask Alter" })
    await api.sendMessage(chat.id, { content: "Recent failures?" })
    expect(path(0)).toMatch(/\/conversations$/); expect(path(2)).toMatch(/\/messages$/)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/drafts"))).toBe(false)
    expect(await api.createConversationDraft(chat.id)).toEqual(chat)
    expect(path(3)).toMatch(/\/drafts$/); expect(JSON.parse(String(init(3).body))).toEqual({})
  })
  it("surfaces real failures and rejects fabricated response shapes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error_code: "CHAT_NOT_FOUND", detail: "Chat unavailable" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ id: "demo", title: "Fake" }))
    await expect(api.getConversation(chat.id)).rejects.toThrow("Chat unavailable")
    await expect(api.getConversation(chat.id)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
