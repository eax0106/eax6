import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/api/http", async original => ({ ...(await original<typeof import("@/api/http")>()), isLiveApi: true }))
import { Home } from "./home"
import { ConversationDetail } from "./conversation-detail"

const id = "cnv_00000000-0000-7000-8000-000000000001"
const draftId = "cnv_00000000-0000-7000-8000-000000000002"
const workflowId = "wf_00000000-0000-7000-8000-000000000002"
const resource = { id, title: "Support", type: "workflow_builder", status: "active", linkedWorkflowId: workflowId,
  createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }
const messages: unknown[] = []
let kind = "workflow_builder", fail = false, requireConnections = false
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  messages.length = 0; kind = "workflow_builder"; fail = false; requireConnections = false; fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input), chat = { ...resource, type: kind, ...(kind === "general" ? { linkedWorkflowId: undefined } : {}) }
    if (path.endsWith("/drafts")) return Response.json({ ...resource, id: draftId, title: "New workflow" })
    if (path.endsWith("/build")) {
      if (fail) return Response.json({ error_code: "PLANNER_UNAVAILABLE", detail: "Planner offline" }, { status: 503 })
      const user = { id: `msg_00000000-0000-7000-8000-${String(messages.length + 3).padStart(12, "0")}`, conversationId: id, role: "user", kind: "text", content: JSON.parse(String(init?.body)).content, createdAt: resource.createdAt }
      const assistant = { ...user, id: `msg_00000000-0000-7000-8000-${String(messages.length + 4).padStart(12, "0")}`, role: "assistant", kind: requireConnections ? "action" : "clarification",
        content: requireConnections ? { text: "Connect every account", type: "connections_required", missing_connections: [
          { connector_type: "github", node_keys: ["one", "three"], reason: "missing" },
          { connector_type: "slack", node_keys: ["two"], reason: "unavailable" },
        ] } : { text: "Need details", questions: ["Which day?", "Which channel?"] } }
      messages.push(user, assistant); return Response.json({ userMessage: user, assistantMessage: assistant })
    }
    if (path.endsWith("/messages")) return Response.json(messages)
    if (init?.method === "POST") {
      kind = JSON.parse(String(init.body)).type
      return Response.json({ ...chat, type: kind, ...(kind === "general" ? { linkedWorkflowId: undefined } : {}) })
    }
    return Response.json(path.endsWith(draftId) ? { ...resource, id: draftId, title: "New workflow" } : chat)
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function mount(path = "/app") {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={query}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/app" element={<Home />} /><Route path="/app/conversations/:conversationId" element={<ConversationDetail />} />
  </Routes></MemoryRouter></QueryClientProvider>)
}
function submit(text: string) {
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: text } }); fireEvent.keyDown(input, { key: "Enter" })
}

describe("live conversation surfaces", () => {
  it("shows every required connection and retries within the existing draft chat", async () => {
    requireConnections = true; mount(`/app/conversations/${id}`); await screen.findByRole("textbox"); submit("Original goal with all requirements")
    expect(await screen.findByText("github — Connect account")).toBeTruthy()
    expect(screen.getByText("slack — Reconnect account")).toBeTruthy()
    const link = screen.getByRole("link", { name: "Open connections in new tab" })
    expect(link.getAttribute("href")).toBe("/app/connections"); expect(link.getAttribute("target")).toBe("_blank")
    requireConnections = false; fireEvent.click(screen.getByRole("button", { name: "Check connections and plan again" }))
    expect(await screen.findByRole("textbox", { name: "Which day?" })).toBeTruthy()
    expect(screen.getByText("Original goal with all requirements")).toBeTruthy()
    const builds = fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/build"))
    expect(builds).toHaveLength(2); expect(builds.every(([path]) => String(path).includes(id))).toBe(true)
    expect(screen.queryByText(/Compiled draft version/)).toBeNull()
  })
  it("Home creates the actual draft/chat and retains the full goal for its builder", async () => {
    mount(); submit("Create support reports with all the original requirements")
    expect(await screen.findByText("Support")).toBeTruthy()
    expect(await screen.findByText("Create support reports with all the original requirements")).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Which day?" })).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Which channel?" })).toBeTruthy()
    const create = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith("/conversations/workflows") && init?.method === "POST")!
    expect(JSON.parse(String(create[1]?.body)).type).toBe("workflow_builder")
    expect(screen.queryByText("Build a customer portal project")).toBeNull()
  })
  it("keeps the created draft when building fails and retries in that same chat", async () => {
    fail = true; mount(); submit("Keep this original goal")
    expect((await screen.findByRole("alert")).textContent).toContain("Planner offline")
    expect(screen.getByRole("link", { name: "Open draft chat" }).getAttribute("href")).toBe(`/app/conversations/${id}`)
    fail = false; fireEvent.click(screen.getByRole("button", { name: "Retry in this draft" }))
    expect(await screen.findByText("Keep this original goal")).toBeTruthy()
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/conversations/workflows") && init?.method === "POST")).toHaveLength(1)
  })
  it("opens the per-user assistant and creates a new draft only through its explicit action", async () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Ask Alter about your workflows" }))
    const action = await screen.findByRole("button", { name: "Create draft workflow" })
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/drafts"))).toBe(false)
    fireEvent.click(action)
    expect(await screen.findByText("New workflow")).toBeTruthy()
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes(draftId))).toBe(true))
    expect(screen.getByRole("link", { name: /Workflow/ }).getAttribute("href")).toBe(`/app/workflows/${workflowId}`)
  })
})
