import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { Workflow } from "@/api/types"
import { WorkflowCreate } from "./workflow-create"

vi.mock("@/api/client", () => ({ api: { compileWorkflow: vi.fn() } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const workflow = { id: "wf_fixture", name: "Triage", status: "draft" } as Workflow
const result = { workflow, explanation: "Review draft", warnings: [], questions: [] }
const missingConnections = [
  { connector_type: "github", node_keys: ["fetch"], reason: "missing" as const },
  { connector_type: "slack", node_keys: ["notify"], reason: "unavailable" as const },
]

describe("WorkflowCreate connection batch and retry", () => {
  it("shows all gaps, keeps the original objective, answers and draft, and retries after connecting", async () => {
    vi.mocked(api.compileWorkflow)
      .mockResolvedValueOnce({ ...result, explanation: "Need inbox", questions: ["Which inbox?"] })
      .mockResolvedValueOnce({ ...result, explanation: "Need team", questions: ["Which team?"] })
      .mockResolvedValueOnce({ ...result, explanation: "Connect these accounts", missingConnections })
      .mockResolvedValueOnce({ ...result, plan: { type: "plan", successCriteria: ["Notify support."], steps: [{ key: "work", type: "llm", description: "Triage", successCriteria: ["Notify support."] }] } })
      .mockResolvedValueOnce(result)
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <MemoryRouter><WorkflowCreate /></MemoryRouter>
    </QueryClientProvider>)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText("Describe a workflow..."), "Triage support mail{Enter}")
    await user.type(await screen.findByLabelText("Which inbox?"), "support")
    await user.click(screen.getByRole("button", { name: "Answer and plan again" }))
    await user.type(await screen.findByLabelText("Which team?"), "customer success")
    await user.click(screen.getByRole("button", { name: "Answer and plan again" }))
    const retry = await screen.findByRole("button", { name: "Check connections and plan again" })
    expect(screen.getByText(/github.*Connect account/)).toBeTruthy()
    expect(screen.getByText(/slack.*Reconnect account/)).toBeTruthy()
    expect(screen.queryByText("Workflow ready for review")).toBeNull()
    const link = screen.getByRole("link", { name: "Open connections in new tab" })
    expect(link.getAttribute("href")).toBe("/app/connections")
    expect(link.getAttribute("target")).toBe("_blank")
    expect((screen.getByPlaceholderText("Describe a workflow...") as HTMLTextAreaElement).disabled).toBe(true)
    await user.click(retry)
    await waitFor(() => expect(api.compileWorkflow).toHaveBeenLastCalledWith({ goal: "Triage support mail", answers: { "Which inbox?": "support", "Which team?": "customer success" }, workflowId: workflow.id }, expect.anything()))
    expect(await screen.findByRole("button", { name: "Build" })).toBeTruthy()
    expect(screen.queryByText("Workflow ready for review")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Build" }))
    expect(await screen.findByText("Workflow ready for review")).toBeTruthy()
    expect(api.compileWorkflow).toHaveBeenLastCalledWith({ goal: "Triage support mail", answers: { "Which inbox?": "support", "Which team?": "customer success" }, workflowId: workflow.id, confirm: true, successCriteria: ["Notify support."] }, expect.anything())
  })
})
