import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/api/http", async original => ({ ...(await original<typeof import("@/api/http")>()), isLiveApi: true }))
import { Home } from "../pages/home"
import { ConversationDetail } from "../pages/conversation-detail"

const workflowId = "wf_00000000-0000-7000-8000-000000000009"
const chatId = "cnv_00000000-0000-7000-8000-000000000009"
const time = "2026-10-06T00:00:00Z"
const chat = { id: chatId, title: "Lead capture to CRM with a welcome email", type: "workflow_builder", status: "active", linkedWorkflowId: workflowId, createdAt: time, updatedAt: time }
const summaries = ["lead-capture-crm-welcome", "support-email-triage", "invoice-email-to-sheet", "weekly-report-digest", "knowledge-qa",
  "meeting-notes-summary", "brand-mention-alert", "whatsapp-faq-responder"].map((template_id, index) => ({
  template_id, version: 1, title: `Template ${index + 1}`, summary: `What template ${index + 1} does.`, requirements: [] }))
const missing = { type: "connections_required", templateId: "lead-capture-crm-welcome", templateVersion: 1,
  missing_connections: [{ connector_type: "postgres", node_keys: ["save_lead"], reason: "missing" }], text: "Connect postgres, then use the template again." }

let existingChats: unknown[] = [], registryDown = false, compiled = false
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  existingChats = []; registryDown = false; compiled = false; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input)
    if (path.endsWith("/api/v1/workflow-templates")) return registryDown ? Response.json({ detail: "Registry offline" }, { status: 503 }) : Response.json(summaries)
    if (path.includes("/instantiate")) {
      const body = JSON.parse(String(init?.body))
      return Response.json(compiled
        ? { status: "compiled", templateId: "lead-capture-crm-welcome", templateVersion: 1, workflowId, conversation: chat, versionId: "wfv_00000000-0000-7000-8000-000000000001" }
        : { status: "connections_required", templateId: "lead-capture-crm-welcome", templateVersion: 1, workflowId: body.workflowId ?? workflowId, conversation: chat,
            missingConnections: missing.missing_connections }, { status: 201 })
    }
    if (path.endsWith("/api/v1/conversations")) return Response.json(existingChats)
    if (path.endsWith(`/conversations/${chatId}`)) return Response.json(chat)
    if (path.endsWith(`/conversations/${chatId}/messages`)) return Response.json([{ id: "msg_00000000-0000-7000-8000-000000000001", conversationId: chatId,
      role: "system", kind: "action", content: missing, createdAt: time }])
    return Response.json({ detail: `unexpected ${path}` }, { status: 404 })
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(path = "/app") {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={query}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/app" element={<Home />} /><Route path="/app/conversations/:conversationId" element={<ConversationDetail />} />
  </Routes></MemoryRouter></QueryClientProvider>)
}

describe("first-run starter templates (D18, design log §19)", () => {
  it("shows the guide and all eight templates below the describe box on first run", async () => {
    mount()
    const heading = await screen.findByRole("heading", { name: "Start from a template" })
    const section = heading.closest("section")!
    expect(await within(section).findAllByRole("button", { name: /^Use template:/ })).toHaveLength(8)
    expect(within(section).getByRole("list", { name: "Getting started" }).querySelectorAll("li")).toHaveLength(3)
    const box = screen.getByRole("textbox")
    expect(box.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("is a first-run affordance only: a user with chats sees no gallery", async () => {
    existingChats = [chat]
    mount()
    expect(await screen.findByText("Create a weekly reporting workflow")).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Start from a template" })).toBeNull()
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/workflow-templates"))).toBe(false)
  })

  it("creates the workflow and its chat from a template and opens that chat", async () => {
    compiled = true
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Use template: Template 1" }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith(`/conversations/${chatId}`))).toBe(true))
    const call = fetchMock.mock.calls.find(([path]) => String(path).includes("/instantiate"))!
    expect(String(call[0])).toContain("/api/v1/workflow-templates/lead-capture-crm-welcome/instantiate")
    expect(call[1]?.method).toBe("POST")
    expect(new Headers(call[1]?.headers).get("idempotency-key")).toBeTruthy()
    expect(JSON.parse(String(call[1]?.body))).toEqual({})
  })

  it("leaves the describe box working when templates cannot be read", async () => {
    registryDown = true
    mount()
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/workflow-templates"))).toBe(true))
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Start from a template" })).toBeNull())
    expect(screen.getByRole("textbox")).toBeTruthy()
  })

  it("retries the same template into the same workflow once its connection exists", async () => {
    mount(`/app/conversations/${chatId}`)
    expect(await screen.findByText("postgres — Connect account")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Check connections and plan again" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Check connections and use the template again" }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/instantiate"))).toBe(true))
    const call = fetchMock.mock.calls.find(([path]) => String(path).includes("/instantiate"))!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ workflowId })
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/build"))).toBe(false)
  })
})
