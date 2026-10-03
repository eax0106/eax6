import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("@/api/http", async original => ({ ...(await original<typeof import("@/api/http")>()), isLiveApi: true }))
import { api } from "@/api/client"
import { compileDag, dagToCanvas } from "@/api/compile-dag"
import { Inspector } from "./inspector"
import { ValidationPanel } from "./validation-panel"
import { useBuilderStore } from "../../stores/useBuilderStore"
import type { NodeOverrideComparison } from "@alterx/contracts"

const workflowId = "wf_00000000-0000-7000-8000-000000000001"
const fetchMock = vi.fn<typeof fetch>()
let canEdit = true, fail = false
const selection = { binding: { record_id: "original-model", version: 2, kind: "model" as const, rationale: "Required reasoning fit", score: .88, factors: { reliability: .9, latency: .8, cost: .5 } },
  policy: { reliability_weight: .4, latency_weight: .3, cost_weight: .3 }, required_capabilities: ["text"], required_model_alias: "ADVANCED" as const, model_alias: "CEILING" as const }
const contract = { type: "object" as const, properties: { summary: { type: "string" as const } }, required: ["summary"] }
function response(): NodeOverrideComparison {
  return { nodeKey: "work", choice: { kind: "model", value: "FAST" }, approval_required: true, original: { choice: { kind: "model", value: "CEILING" }, selection },
    candidate: { record_id: "fast-model", version: 1, kind: "model", source_node_key: "work", rationale: "Original weights", score: .7, factors: { reliability: .7 }, output_contract: contract },
    warnings: [{ code: "model_tier", message: "Chosen alias FAST is below required tier ADVANCED." }], cost: { currency: "INR", before_minor: 2500, after_minor: 500 },
    validation: { valid: true, errors: [] }, data_contract: { output: contract } }
}
beforeEach(() => {
  canEdit = true; fail = false; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(api, "getNodeTypes").mockResolvedValue([{ type: "LLMTask", name: "Model task", category: "execution", configSchema: { model_alias: { type: "string", label: "Old model field" } } }] as any)
  const dag = compileDag([{ id: "work", type: "LLMTask", position: { x: 0, y: 0 }, data: { label: "Work", model_alias: "CEILING", prompt: "Review invoices", successCriteria: ["Report totals."] } }], [], ["Review totals."])
  dag.nodes[0]!.metadata.selection_binding = selection
  dag.nodes[0]!.metadata.original_choice = { kind: "model", value: "CEILING" }
  const canvas = dagToCanvas(dag)
  useBuilderStore.setState({ workflowId, ...canvas, successCriteria: dag.success_criteria, selectedNodeId: "work", inspectorOpen: true, isDirty: false })
  fetchMock.mockImplementation(async (_url, options) => options?.method === "POST"
    ? fail ? Response.json({ detail: "Unavailable", error_code: "OVERRIDE_UNAVAILABLE" }, { status: 503 }) : Response.json(response())
    : Response.json({ can_edit: canEdit }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(label = "Model alias") {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Inspector /><ValidationPanel /></QueryClientProvider>)
  await waitFor(() => expect((screen.getByRole("combobox", { name: label }) as HTMLSelectElement).disabled).toBe(!canEdit))
}
const posts = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")

it("live canonical tool picker keeps an outside choice selected while showing required boundary errors", async () => {
  const dag = compileDag([{ id: "work", type: "ToolCall", position: { x: 0, y: 0 }, data: { label: "Search", tool_name: "search.web" } }], [])
  dag.nodes[0]!.metadata.original_choice = { kind: "tool", value: "search.web" }
  useBuilderStore.setState({ ...dagToCanvas(dag), selectedNodeId: "work", successCriteria: undefined })
  const advice: NodeOverrideComparison = { ...response(), choice: { kind: "tool", value: "email.send" }, original: { choice: { kind: "tool", value: "search.web" }, selection: null }, candidate: null,
    cost: { currency: "INR", before_minor: null, after_minor: null }, data_contract: {}, warnings: [{ code: "outside_action", message: "Chosen tool adds an outside action." }], validation: { valid: false, errors: ["Normal verification and approval steps are required."] } }
  fetchMock.mockImplementation(async (_url, options) => options?.method === "POST" ? Response.json(advice) : Response.json({ can_edit: true }))
  await mount("Canonical tool")
  expect(screen.getByText("Original pick: search.web")).toBeTruthy()
  expect(screen.getAllByRole("option")).toHaveLength(11)
  fireEvent.change(screen.getByRole("combobox", { name: "Canonical tool" }), { target: { value: "email.send" } })
  expect(await screen.findByText("Chosen tool adds an outside action.")).toBeTruthy()
  expect(await screen.findByText("Normal verification and approval steps are required.")).toBeTruthy()
  expect(useBuilderStore.getState().nodes[0]!.data).toMatchObject({ tool_name: "email.send", manual_tool_override: true })
  const body = JSON.parse(String(posts()[0]![1]!.body))
  expect(body.choice).toEqual({ kind: "tool", value: "email.send" })
  expect(body.dag.nodes[0].config.tool_name).toBe("email.send")
  expect(body.dag.nodes[0].config.manual_tool_override).toBe(true)
})

it("live inspector carries a confirmed manual alias, keeps criteria/evidence separate and displays scored advisory without blocking", async () => {
  await mount()
  expect(screen.getByText("Original pick: CEILING")).toBeTruthy(); expect(screen.getByText("Required reasoning fit")).toBeTruthy()
  expect(screen.queryByLabelText("Old model field")).toBeNull()
  fireEvent.change(screen.getByRole("combobox", { name: "Model alias" }), { target: { value: "FAST" } })
  expect(await screen.findByText("Chosen alias FAST is below required tier ADVANCED.")).toBeTruthy()
  expect(screen.getByText("Candidate score: 0.700")).toBeTruthy(); expect(screen.getByText("Graph validation passed.")).toBeTruthy()
  const body = JSON.parse(String(posts()[0]![1]!.body)), node = body.dag.nodes[0]
  expect(String(posts()[0]![0])).toContain(`/workflows/${workflowId}/node-overrides/compare`)
  expect(body.choice).toEqual({ kind: "model", value: "FAST" }); expect(node.config.model_alias).toBe("FAST"); expect(node.config.manual_model_override).toBe(true)
  expect(node.config).not.toHaveProperty("engineMetadata"); expect(node.config).not.toHaveProperty("successCriteria")
  expect(node.metadata.selection_binding).toEqual(selection); expect(body.dag.success_criteria).toEqual(["Review totals."]); expect(node.success_criteria).toEqual(["Report totals."])
  expect(useBuilderStore.getState().nodes[0]!.data.model_alias).toBe("FAST"); expect(useBuilderStore.getState().isDirty).toBe(true)
})
it("retains the manual choice after a failed comparison and permits retry", async () => {
  await mount(); fail = true
  fireEvent.change(screen.getByRole("combobox", { name: "Model alias" }), { target: { value: "FAST" } })
  expect(await screen.findByText("Comparison could not be loaded. Your choice is kept; try again.")).toBeTruthy()
  expect(useBuilderStore.getState().nodes[0]!.data).toMatchObject({ model_alias: "FAST", manual_model_override: true })
  fail = false; fireEvent.click(screen.getByRole("button", { name: "Compare choice" }))
  expect(await screen.findByText("Candidate score: 0.700")).toBeTruthy(); expect(posts()).toHaveLength(2)
})
it("disables choices for a viewer and never requests a comparison", async () => {
  canEdit = false; await mount()
  expect(await screen.findByText("Editor rights are required to change this node.")).toBeTruthy()
  expect((screen.getByRole("combobox", { name: "Model alias" }) as HTMLSelectElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: "Compare choice" }) as HTMLButtonElement).disabled).toBe(true)
  expect(posts()).toHaveLength(0)
})
it("preserves newer graph edits when comparison completes later", async () => {
  await mount(); let finish!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.change(screen.getByRole("combobox", { name: "Model alias" }), { target: { value: "FAST" } })
  await waitFor(() => expect(posts()).toHaveLength(1))
  act(() => useBuilderStore.getState().updateNodeData("work", { prompt: "Newest prompt" }))
  await act(async () => finish(Response.json(response())))
  expect(await screen.findByText("Graph changed during comparison. Compare the current choice again.")).toBeTruthy()
  expect(useBuilderStore.getState().nodes[0]!.data).toMatchObject({ model_alias: "FAST", prompt: "Newest prompt" })
})
it("reruns the shared downstream type validator after a manual choice without discarding that choice", async () => {
  await mount()
  act(() => {
    const current = useBuilderStore.getState()
    current.setNodes([...current.nodes, { id: "next", type: "ToolCall", position: { x: 0, y: 100 }, data: { label: "Next", tool_name: "search.web", engineMetadata: { ui: {}, data_contract: { inputs: { work: { type: "number" } } } } } }])
    current.setEdges([{ id: "e", source: "work", target: "next" }])
  })
  fireEvent.change(screen.getByRole("combobox", { name: "Model alias" }), { target: { value: "FAST" } })
  expect(await screen.findByText("Output contract does not fit downstream input: work to next")).toBeTruthy()
  expect(useBuilderStore.getState().nodes[0]!.data.model_alias).toBe("FAST")
})
