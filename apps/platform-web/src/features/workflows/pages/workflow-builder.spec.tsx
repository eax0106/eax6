import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("@/api/http", async original => ({ ...(await original<typeof import("@/api/http")>()), isLiveApi: true }))
vi.mock("../components/builder/canvas", () => ({ WorkflowCanvas: () => null }))
vi.mock("../components/builder/node-palette", () => ({ NodePalette: () => null }))
vi.mock("../components/builder/inspector", () => ({ Inspector: () => null }))
vi.mock("../components/builder/validation-panel", () => ({ ValidationPanel: () => null }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { compileDag } from "@/api/compile-dag"
import { WorkflowBuilder } from "./workflow-builder"
import { useBuilderStore } from "../stores/useBuilderStore"

const id = "wf_00000000-0000-7000-8000-000000000001"
const criteria = ["Notify support."]
const fetchMock = vi.fn<typeof fetch>()
let fail = false
let workflow: ReturnType<typeof resource>
function resource() { return { id, name: "Criteria workflow", status: "active", updatedAt: "2026-10-03T00:00:00Z",
  dag: compileDag([{ id: "work", type: "LLMTask", position: { x: 0, y: 0 }, data: { prompt: "Old prompt", successCriteria: criteria } }], [], criteria) } }
beforeEach(() => {
  fail = false; workflow = resource(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock)
  useBuilderStore.setState({ workflowId: undefined, nodes: [], edges: [], successCriteria: undefined, isDirty: false, selectedNodeId: null, inspectorOpen: false })
  fetchMock.mockImplementation(async (_input, options) => options?.method === "PATCH" && fail
    ? Response.json({ detail: "Save offline", error_code: "WORKFLOW_UNAVAILABLE" }, { status: 503 }) : Response.json(workflow))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
async function mount() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter initialEntries={[`/app/workflows/${id}/build`]}><Routes>
      <Route path="/app/workflows/:workflowId/build" element={<WorkflowBuilder />} />
      <Route path="/app/conversations/:conversationId" element={<p>Review goal in planner</p>} />
    </Routes></MemoryRouter>
  </QueryClientProvider>)
  await screen.findByText("Criteria workflow")
  await waitFor(() => expect(useBuilderStore.getState().nodes).toHaveLength(1))
}
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH")
const edit = () => act(() => useBuilderStore.getState().updateNodeData("work", { prompt: "Edited prompt" }))

it("asks before changing a live step, cancels without a write, then saves existing criteria through actual HTTP and retains the saved graph", async () => {
  await mount(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.queryByRole("alertdialog")).not.toBeNull(); expect(writes()).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(useBuilderStore.getState().isDirty).toBe(true); expect(writes()).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "Save" })); fireEvent.click(screen.getByRole("button", { name: "Goal unchanged — save" }))
  await waitFor(() => expect(useBuilderStore.getState().isDirty).toBe(false))
  expect(writes()).toHaveLength(1)
  const body = JSON.parse(String(writes()[0]![1]!.body))
  expect(body.dag.success_criteria).toEqual(criteria); expect(body.dag.nodes[0].success_criteria).toEqual(criteria)
  expect(body.dag.nodes[0].config.prompt).toBe("Edited prompt"); expect(body.dag.nodes[0].config).not.toHaveProperty("successCriteria")
  expect(useBuilderStore.getState().nodes[0]!.data.prompt).toBe("Edited prompt")
  expect(screen.queryByRole("alertdialog")).toBeNull()
})
it("a changed goal opens the same workflow chat and keeps its unsaved canvas", async () => {
  await mount(); edit(); fireEvent.click(screen.getByRole("button", { name: "Save" }))
  fireEvent.click(screen.getByRole("button", { name: "Goal changed — review plan" }))
  expect(await screen.findByText("Review goal in planner")).toBeTruthy()
  expect(useBuilderStore.getState().workflowId).toBe(id); expect(useBuilderStore.getState().isDirty).toBe(true); expect(writes()).toHaveLength(0)
})
it("position-only edits do not ask about the goal", async () => {
  await mount()
  act(() => useBuilderStore.getState().setNodes(useBuilderStore.getState().nodes.map(node => ({ ...node, position: { x: 100, y: 80 } }))))
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(writes()).toHaveLength(1)); expect(screen.queryByRole("alertdialog")).toBeNull()
})
it("failed saves keep the edited graph and criteria for retry", async () => {
  await mount(); edit(); fail = true; fireEvent.click(screen.getByRole("button", { name: "Save" }))
  fireEvent.click(screen.getByRole("button", { name: "Goal unchanged — save" }))
  await waitFor(() => expect(writes()).toHaveLength(1))
  await waitFor(() => expect((screen.getByRole("button", { name: "Goal unchanged — save" }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.getByRole("alertdialog")).toBeTruthy(); expect(useBuilderStore.getState().isDirty).toBe(true)
  expect(useBuilderStore.getState().nodes[0]!.data.prompt).toBe("Edited prompt"); expect(useBuilderStore.getState().successCriteria).toEqual(criteria)
  fail = false; fireEvent.click(screen.getByRole("button", { name: "Goal unchanged — save" }))
  await waitFor(() => expect(useBuilderStore.getState().isDirty).toBe(false)); expect(writes()).toHaveLength(2)
})
it("saving an earlier snapshot keeps edits made while the request was pending", async () => {
  await mount(); edit()
  let finish!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole("button", { name: "Save" })); fireEvent.click(screen.getByRole("button", { name: "Goal unchanged — save" }))
  await waitFor(() => expect(writes()).toHaveLength(1))
  act(() => useBuilderStore.getState().updateNodeData("work", { prompt: "Newest unsaved prompt" }))
  await act(async () => finish(Response.json(workflow)))
  expect(useBuilderStore.getState().isDirty).toBe(true); expect(useBuilderStore.getState().nodes[0]!.data.prompt).toBe("Newest unsaved prompt")
})
it("switching workflows resets prior graph and criteria", async () => {
  await mount(); edit(); cleanup()
  act(() => useBuilderStore.getState().setWorkflowId("wf_other"))
  expect(useBuilderStore.getState().nodes).toEqual([]); expect(useBuilderStore.getState().successCriteria).toBeUndefined(); expect(useBuilderStore.getState().isDirty).toBe(false)
})
