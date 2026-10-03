import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/api/http", async original => ({ ...(await original<typeof import("@/api/http")>()), isLiveApi: true }))
import { Home } from "./home"
import { ConversationDetail } from "./conversation-detail"
import { WorkflowCreate } from "../../workflows/pages/workflow-create"

const id = "cnv_00000000-0000-7000-8000-000000000001"
const draftId = "cnv_00000000-0000-7000-8000-000000000002"
const workflowId = "wf_00000000-0000-7000-8000-000000000002"
const resource = { id, title: "Support", type: "workflow_builder", status: "active", linkedWorkflowId: workflowId,
  createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }
const messages: unknown[] = []
const plan = { type: "plan", successCriteria: ["Notify support.", "Old criterion."], steps: [{ key: "work", type: "llm", description: "Triage mail", successCriteria: ["Notify support.", "Old criterion."] }] }
let kind = "workflow_builder", fail = false, requireConnections = false, planFlow = false, questionsOnBuild = false
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  messages.length = 0; kind = "workflow_builder"; fail = false; requireConnections = false; planFlow = false; questionsOnBuild = false; fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input), chat = { ...resource, type: kind, ...(kind === "general" ? { linkedWorkflowId: undefined } : {}) }
    if (path.includes("/api/v1/workflows")) {
      const workflow = { id: workflowId, name: "Support", status: "draft", updatedAt: resource.createdAt }
      if (path.endsWith("/actions/plan")) {
        if (fail) return Response.json({ detail: "Planner offline" }, { status: 503 })
        const input = JSON.parse(String(init?.body))
        return Response.json(!input.confirm ? plan : questionsOnBuild ? { type: "clarification", questions: ["Which channel?"] } : { type: "compiled", versionId: "wfv_fixture" })
      }
      return Response.json(workflow)
    }
    if (path.endsWith("/drafts")) return Response.json({ ...resource, id: draftId, title: "New workflow" })
    if (path.endsWith("/build")) {
      if (fail) return Response.json({ error_code: "PLANNER_UNAVAILABLE", detail: "Planner offline" }, { status: 503 })
      const payload = JSON.parse(String(init?.body))
      const user = { id: `msg_00000000-0000-7000-8000-${String(messages.length + 3).padStart(12, "0")}`, conversationId: id, role: "user", kind: "text", content: payload.build ? { text: payload.content, build: payload.build } : payload.content, createdAt: resource.createdAt }
      const assistant = { ...user, id: `msg_00000000-0000-7000-8000-${String(messages.length + 4).padStart(12, "0")}`, role: "assistant", kind: requireConnections ? "action" : "clarification",
        content: requireConnections ? { text: "Connect every account", type: "connections_required", missing_connections: [
          { connector_type: "github", node_keys: ["one", "three"], reason: "missing" },
          { connector_type: "slack", node_keys: ["two"], reason: "unavailable" },
        ] } : { text: "Need details", questions: ["Which day?", "Which channel?"] } as Record<string, unknown> }
      if (planFlow) {
        assistant.kind = !payload.build ? "artifact" : questionsOnBuild ? "clarification" : "workflow"
        assistant.content = !payload.build ? { ...plan, text: "Review plan", objective: payload.content } : questionsOnBuild ? { text: "Clarify criterion", questions: ["Which channel?"], build: payload.build } : { text: "Compiled confirmed plan", workflowId }
      }
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
    <Route path="/app/workflows/new" element={<WorkflowCreate />} /><Route path="/app" element={<Home />} /><Route path="/app/conversations/:conversationId" element={<ConversationDetail />} />
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

it.each(["chat", "create"])("%s live plan retains edited, added and removed criteria through failed Build and clarification retry", async surface => {
  planFlow = true; mount(surface === "chat" ? `/app/conversations/${id}` : "/app/workflows/new")
  await screen.findByRole("textbox"); submit("Original triage goal")
  const criterion = await screen.findByRole("textbox", { name: "Success criterion 1" })
  fireEvent.change(criterion, { target: { value: "Notify billing." } })
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 2" }))
  fireEvent.click(screen.getByRole("button", { name: "Add criterion" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Success criterion 2" }), { target: { value: "Archive mail." } })
  expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith(surface === "chat" ? "/build" : "/actions/plan"))).toHaveLength(1)
  fail = true; fireEvent.click(screen.getByRole("button", { name: "Build" }))
  expect((await screen.findByRole("alert")).textContent).toContain("Planner offline")
  expect((screen.getByRole("textbox", { name: "Success criterion 1" }) as HTMLInputElement).value).toBe("Notify billing.")
  fail = false; questionsOnBuild = true; fireEvent.click(screen.getByRole("button", { name: "Build" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Which channel?" }), { target: { value: "billing" } })
  questionsOnBuild = false; fireEvent.click(screen.getByRole("button", { name: surface === "chat" ? "Answer and continue" : "Answer and plan again" }))
  expect(await screen.findByText(surface === "chat" ? "Compiled confirmed plan" : "Workflow ready for review")).toBeTruthy()
  const requests = fetchMock.mock.calls.filter(([path]) => String(path).endsWith(surface === "chat" ? "/build" : "/actions/plan"))
  const body = JSON.parse(String(requests.at(-1)![1]!.body))
  expect(surface === "chat" ? body.build.successCriteria : body.successCriteria).toEqual(["Notify billing.", "Archive mail."])
  if (surface === "chat") { expect(body.build.planMessageId).toBe((messages[1] as { id: string }).id); expect(body.content).toContain("billing") }
  else { expect(body.confirm).toBe(true); expect(body.goal).toBe("Original triage goal"); expect(body.answers).toEqual({ "Which channel?": "billing" }) }
})
